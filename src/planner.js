const { logger } = require('./utils');
const llm = require('./llm_client');
const config = require('./config');
const memory = require('./memory_store');
const TaskManager = require('./task_manager');

class Planner {
    constructor(bot, skills, perception) {
        this.bot = bot;
        this.skills = skills;
        this.perception = perception;
        this.taskManager = new TaskManager(bot, skills);
        this.mode = config.behavior.defaultMode; // 'manual' or 'autonomous'
        this.isRunning = false;
        this.taskQueue = [];
        this.lastLLMAt = 0;
        this.lastSocialChatAt = 0;
        this.socialIndex = 0;
        this.lastSpokeAt = new Map();
    }

    shouldQueryLLM() {
        const cooldownMs = config.behavior.chatCooldown || 0;
        if (cooldownMs <= 0) return true;
        const now = Date.now();
        if (now - this.lastLLMAt < cooldownMs) return false;
        this.lastLLMAt = now;
        return true;
    }

    getSocialTarget(players) {
        const intervalMs = config.behavior.socialRoundInterval || 0;
        if (intervalMs <= 0) return null;
        const now = Date.now();
        if (now - this.lastSocialChatAt < intervalMs) return null;

        const candidates = (players || [])
            .filter(p => p && p.name && p.name !== this.bot.username);
        const eligible = candidates.filter(p => this.canAddressPlayer(p.name));
        if (eligible.length === 0) return null;

        const ordered = eligible
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        const idx = this.socialIndex % ordered.length;
        return ordered[idx];
    }

    markSocialSpoke() {
        this.lastSocialChatAt = Date.now();
        this.socialIndex += 1;
    }

    canAddressPlayer(name) {
        if (!name) return false;
        if (memory.isMuted(name)) return false;
        const cooldownMs = config.behavior.perPlayerChatCooldown || 0;
        if (cooldownMs <= 0) return true;
        const last = this.lastSpokeAt.get(name) || 0;
        return Date.now() - last >= cooldownMs;
    }

    markPlayerSpoke(name) {
        if (!name) return;
        this.lastSpokeAt.set(name, Date.now());
    }

    getMemoryContext(scanResult, sender) {
        const memContext = {};
        const players = Array.isArray(scanResult.players) ? scanResult.players : [];

        for (const player of players) {
            const mem = memory.getPlayer(player.name);
            if (mem && mem.facts && mem.facts.length > 0) {
                memContext[player.name] = mem.facts;
            }
        }

        // Memory for sender
        if (sender) {
            const mem = memory.getPlayer(sender);
            if (mem && mem.facts && mem.facts.length > 0) {
                memContext[sender] = mem.facts;
            }
        }
        
        return memContext;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    stop() {
        this.isRunning = false;
        if (this.taskManager) {
            this.taskManager.stopTask();
        }
    }

    setMode(mode) {
        if (['manual', 'autonomous', 'survival'].includes(mode)) {
            this.mode = mode;
            logger.info(`Mode set to: ${mode}`);
        }
    }

    async loop() {
        while (this.isRunning) {
            try {
                // 1. Task Manager Update (High Priority)
                if (await this.taskManager.update()) {
                    await new Promise(r => setTimeout(r, 500)); // Fast tick for tasks
                    continue; 
                }

                // 2. LLM Decision (Low Priority)
                if (this.mode === 'autonomous' || this.mode === 'survival') {
                    await this.autonomousStep();
                } else {
                    // Manual mode: process queue or wait
                    if (this.taskQueue.length > 0) {
                        const task = this.taskQueue.shift();
                        await this.executeTask(task);
                    }
                }
            } catch (e) {
                logger.error('Planner loop error', e);
            }
            await new Promise(r => setTimeout(r, 2000)); // Tick rate for LLM
        }
    }

    async autonomousStep() {
        if (!this.shouldQueryLLM()) return;
        const isMoving = this.bot.pathfinder.isMoving();
        const scan = this.perception.scan();
        const memories = this.getMemoryContext(scan, null);
        const recentChat = memory.getRecentInteractions(config.behavior.maxChatHistory || 20);
        const globalChat = memory.getRecentGlobalChat(config.behavior.maxChatHistory || 20);
        const worldFacts = memory.getWorldFacts(20);
        const worldEvents = memory.getWorldEvents(20);
        const socialTarget = this.getSocialTarget(scan.players);
        const behavior = config.behavior || {};

        const context = {
             ...scan,
             isMoving: isMoving,
             memory: memories,
             recentChat: recentChat,
             globalChat: globalChat,
             worldFacts: worldFacts,
             worldEvents: worldEvents,
             socialTarget: socialTarget ? {
                 name: socialTarget.name,
                 position: socialTarget.position,
                 distance: socialTarget.distance,
                 hasEntity: socialTarget.hasEntity,
                 lastSeen: socialTarget.lastSeen,
                 lastPosition: socialTarget.lastPosition
             } : null
        };
        
        let prompt = "";
        
        if (this.mode === 'autonomous') {
            // Social Mode
            prompt = "Ты в АВТОНОМНОМ режиме (Social). Твоя цель: быть назойливым, смешным и активным. ";
            prompt += "1. Если видишь игрока: подойди (follow) и начни диалог. Используй факты из памяти (memory) для подколов. ";
            prompt += "2. Если игрок молчит - пошути про него, про скин, или придумай сплетню. ";
            prompt += "3. Меняй жертв. Если с одним скучно - иди к другому. ";
            prompt += "4. Анализируй список игроков в Context.players и общайся со всеми в общем чате по очереди. ";
            prompt += "5. Если никого рядом нет - исследуй мир (wander) и комментируй в чат свои находки. ";
            if (socialTarget) {
                prompt += ` СЕЙЧАС социальный обход: адресуйся игроку ${socialTarget.name} в общем чате. Обязательно упомяни ник. `;
            }
            
            if (isMoving) {
                 prompt += "Ты идешь. Если видишь игрока - напиши ему (chat). Если цель далеко - можешь сменить цель.";
            }
            
            if (context.nearbyEntities.some(e => e.type === 'player')) {
                prompt += " ВАЖНО: ИГРОК РЯДОМ! НЕ МОЛЧИ! ИСПОЛЬЗУЙ 'remember_fact' ЕСЛИ УЗНАЛ ЧТО-ТО НОВОЕ.";
            }
        } else if (this.mode === 'survival') {
            // Survival Mode
             prompt = "Ты в режиме ВЫЖИВАНИЯ (Survival). Твоя цель: выжить, добыть ресурсы, скрафтить броню и стать крутым. ";
             prompt += "Если нужно много ресурсов (например, дерева), используй 'start_mining_task' чтобы я сам собирал, пока не наберется. ";
             prompt += "1. Еда и Здоровье — приоритет. ";
             prompt += "2. Инструменты: Дерево -> Доски -> Верстак -> Кирка. ";
             prompt += "3. Игроков игнорируй, если они не мешают.";
        }

        const decision = await llm.generateResponse(prompt, context);
        
        if (!decision && socialTarget) {
            this.bot.chat(`${socialTarget.name}, как ты там?`);
            this.markSocialSpoke();
            this.markPlayerSpoke(socialTarget.name);
            return;
        }

        let usedSocial = false;
        if (decision && socialTarget) {
            const targetName = socialTarget.name;
            if (!decision.chat) {
                decision.chat = `${targetName}, как ты там?`;
                usedSocial = true;
            } else {
                const chatText = String(decision.chat);
                if (!chatText.toLowerCase().includes(targetName.toLowerCase())) {
                    decision.chat = `${targetName}, ${chatText}`;
                }
                usedSocial = true;
            }
        }

        if (decision) await this.executeDecision(decision);
        if (usedSocial) {
            this.markSocialSpoke();
            this.markPlayerSpoke(socialTarget.name);
        }

        const autoPickup = behavior.autoPickupDrops !== false;
        if (autoPickup && scan.nearbyDrops && scan.nearbyDrops.length > 0 && !isMoving && !this.taskManager.isBusy()) {
            await this.skills.pickup_item({ radius: behavior.scanRadiusDrops || 18 });
        }

        const hasVisiblePlayers = scan.players && scan.players.some(p => p.hasEntity);
        if (!isMoving && !this.taskManager.isBusy() && !hasVisiblePlayers) {
            const range = Number.isFinite(Number(behavior.wanderRange)) ? Number(behavior.wanderRange) : 24;
            await this.skills.wander({ range });
        }
    }

    async processUserRequest(username, message, options = {}) {
        if (!this.shouldQueryLLM()) return;
        if (options.passive && memory.isMuted(username)) return;
        const scan = this.perception.scan();
        const memories = this.getMemoryContext(scan, username);
        const recentChat = memory.getRecentInteractions(config.behavior.maxChatHistory || 20);
        const globalChat = memory.getRecentGlobalChat(config.behavior.maxChatHistory || 20);
        const worldFacts = memory.getWorldFacts(20);
        const worldEvents = memory.getWorldEvents(20);
        
        const context = {
            ...scan,
            lastSender: username,
            memory: memories,
            recentChat: recentChat,
            globalChat: globalChat,
            worldFacts: worldFacts,
            worldEvents: worldEvents
        };
        const promptParts = [
            `Игрок ${username} пишет: "${message}".`,
            "Если просят запомнить - используй remember_fact.",
            "Если просят добыть много - start_mining_task.",
            options.passive ? "Сообщение из общего чата: ответь коротко и по делу. Не молчи, но избегай лишних действий." : ""
        ];
        const decision = await llm.generateResponse(promptParts.filter(Boolean).join(' '), context);
        
        if (decision) {
            await this.executeDecision(decision);
            return;
        }
        if (!llm.isAvailable()) {
            this.bot.chat('llm сейчас недоступен, попробуй позже');
        } else {
            this.bot.chat('чёт не понял, повтори');
        }
    }

    async executeDecision(decision) {
        if (decision.thought) logger.info(`Think: ${decision.thought}`);
        
        if (decision.chat !== null && decision.chat !== undefined) {
             this.bot.chat(String(decision.chat));
        }

        if (decision.actions && Array.isArray(decision.actions) && decision.actions.length > 0) {
            for (const action of decision.actions) {
                if (!action || !action.name) continue;
                const args = action.args || {};
                logger.info(`Action: ${action.name}`, args);
                
                // Special handling for tasks
                if (action.name === 'start_mining_task') {
                     const target = args.name || args.target || args.target_block;
                     if (!target) {
                         logger.warn('start_mining_task missing target');
                         continue;
                     }
                     this.taskManager.startTask({ type: 'mine', target: target, amount: args.count || 10 });
                     continue;
                }
                if (action.name === 'start_gather_wood' || action.name === 'start_wood_task') {
                    const amount = Number.isFinite(Number(args.count)) ? Number(args.count) : 32;
                    const types = args.types || args.wood_types || args.woods;
                    this.taskManager.startTask({ type: 'gather_wood', amount, types });
                    continue;
                }
                if (action.name === 'start_farm_task' || action.name === 'start_farming_task') {
                    const crops = args.crops || args.crop_types;
                    this.taskManager.startTask({ type: 'farm', crops });
                    continue;
                }
                
                if (this.skills[action.name]) {
                    try {
                         await this.skills[action.name](args);
                    } catch (e) {
                        logger.error(`Skill ${action.name} failed`, e);
                        this.bot.chat(`сек, не могу сделать ${action.name}, чет сломалось`);
                    }
                } else {
                    logger.warn(`Unknown skill: ${action.name}`);
                }
            }
        }
    }

    async executeTask(task) {
        // Simplified manual task execution
        logger.info('Executing manual task', task);
    }
}

module.exports = Planner;
