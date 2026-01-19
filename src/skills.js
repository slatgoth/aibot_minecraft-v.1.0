const { goals } = require('mineflayer-pathfinder');
const { logger, sleep } = require('./utils');
const config = require('./config');
const Vec3 = require('vec3');

const memory = require('./memory_store');

const ITEM_ALIASES = new Map([
    ['дуб', 'oak_log'],
    ['дубовое бревно', 'oak_log'],
    ['бревно дуба', 'oak_log'],
    ['береза', 'birch_log'],
    ['береза бревно', 'birch_log'],
    ['березовое бревно', 'birch_log'],
    ['ель', 'spruce_log'],
    ['ель бревно', 'spruce_log'],
    ['сосна', 'spruce_log'],
    ['акация', 'acacia_log'],
    ['тёмный дуб', 'dark_oak_log'],
    ['темный дуб', 'dark_oak_log'],
    ['мангров', 'mangrove_log'],
    ['вишня', 'cherry_log'],
    ['доски', 'oak_planks'],
    ['дубовые доски', 'oak_planks'],
    ['березовые доски', 'birch_planks'],
    ['ельные доски', 'spruce_planks'],
    ['каменный', 'stone'],
    ['камень', 'stone'],
    ['булыжник', 'cobblestone'],
    ['уголь', 'coal'],
    ['железо', 'iron_ore'],
    ['золото', 'gold_ore']
]);

class Skills {
    constructor(bot) {
        this.bot = bot;
        this.lastWanderAt = 0;
        this.lastWanderTarget = null;
        this.followHistory = new Map();
        this.itemParser = require('prismarine-item')(bot.version);
    }

    normalizeItemName(name) {
        if (!name) return name;
        const raw = String(name).toLowerCase().trim();
        if (ITEM_ALIASES.has(raw)) return ITEM_ALIASES.get(raw);
        const normalized = raw.replace(/\s+/g, '_');
        if (ITEM_ALIASES.has(normalized)) return ITEM_ALIASES.get(normalized);
        return normalized;
    }

    isStructureBlockName(name) {
        if (!name) return false;
        const patterns = [
            'planks', 'brick', 'bricks', 'stairs', 'slab', 'wall', 'fence', 'gate',
            'door', 'trapdoor', 'glass', 'pane', 'torch', 'lantern', 'bed', 'carpet',
            'banner', 'sign', 'chest', 'barrel', 'furnace', 'crafting_table', 'anvil',
            'smithing', 'enchanting', 'loom', 'cartography', 'stonecutter',
            'grindstone', 'lectern', 'jukebox', 'composter', 'beehive', 'beacon',
            'concrete', 'terracotta', 'wool', 'glazed', 'prismarine', 'quartz',
            'deepslate_bricks', 'polished', 'smooth', 'tiles'
        ];
        return patterns.some(p => name.includes(p));
    }

    hasLeavesNearby(position) {
        const offsets = [];
        for (let dx = -2; dx <= 2; dx += 1) {
            for (let dy = -2; dy <= 2; dy += 1) {
                for (let dz = -2; dz <= 2; dz += 1) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    offsets.push(new Vec3(dx, dy, dz));
                }
            }
        }
        for (const offset of offsets) {
            const block = this.bot.blockAt(position.plus(offset));
            if (block && block.name && block.name.includes('leaves')) {
                return true;
            }
        }
        return false;
    }

    isLikelyNaturalBlock(block) {
        if (!block || !block.name) return false;
        const name = block.name;
        if (name.includes('_ore')) return true;
        const naturalNames = new Set([
            'stone', 'deepslate', 'dirt', 'grass_block', 'sand', 'red_sand', 'gravel',
            'clay', 'netherrack', 'basalt', 'blackstone', 'end_stone', 'andesite',
            'diorite', 'granite', 'cobblestone', 'mossy_cobblestone', 'sandstone',
            'red_sandstone', 'soul_sand', 'soul_soil', 'snow', 'ice', 'packed_ice',
            'blue_ice', 'terracotta', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
            'emerald_ore', 'copper_ore', 'lapis_ore', 'redstone_ore'
        ]);
        if (naturalNames.has(name)) return true;
        if (name.endsWith('_log') || name.endsWith('_wood')) {
            return this.hasLeavesNearby(block.position);
        }
        if (name.includes('leaves')) return true;
        return false;
    }

    isSafeToMine(block) {
        if (!block || !block.position || !block.name) return false;
        if (config.behavior && config.behavior.safeMining === false) return true;
        if (memory.isPlayerPlaced(block)) return false;
        if (this.isStructureBlockName(block.name)) return false;
        if (!this.isLikelyNaturalBlock(block)) return false;

        const adjacent = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
            new Vec3(0, 1, 0), new Vec3(0, -1, 0)
        ];
        for (const offset of adjacent) {
            const neighbor = this.bot.blockAt(block.position.plus(offset));
            if (neighbor && neighbor.name && this.isStructureBlockName(neighbor.name)) {
                return false;
            }
        }
        return true;
    }

    getItemEntityName(entity) {
        const meta = Array.isArray(entity.metadata) ? entity.metadata : [];
        let stack = null;
        for (const entry of meta) {
            if (!entry || typeof entry !== 'object') continue;
            if (Object.prototype.hasOwnProperty.call(entry, 'itemId')) {
                stack = entry;
                break;
            }
            if (entry.present && entry.itemId !== undefined) {
                stack = entry;
                break;
            }
        }
        if (!stack || stack.itemId === undefined) return null;
        const item = this.itemParser.fromNotch({
            type: stack.itemId,
            count: stack.itemCount || 1,
            nbt: stack.nbt || stack.itemNbt || null
        });
        return item && item.name ? item.name : null;
    }

    async remember_fact(args = {}) {
        const { player_name, fact } = args;
        if (!player_name || !fact) {
            logger.warn('remember_fact missing data');
            return;
        }
        memory.addFact(player_name, fact);
        if (config.behavior && config.behavior.announceMemory) {
            this.bot.chat(`запомнил про ${player_name}: ${fact}`);
        }
        logger.info(`Memory saved: ${player_name} -> ${fact}`);
    }

    async remember_world_fact(args = {}) {
        const { fact } = args;
        if (!fact) {
            logger.warn('remember_world_fact missing data');
            return;
        }
        memory.addWorldFact(fact, 'llm');
        logger.info(`World memory saved: ${fact}`);
    }

    async say(args) {
        let text = args;
        if (typeof args === 'object' && args.text) {
            text = args.text;
        }
        this.bot.chat(String(text));
    }

    async whisper(args = {}) {
        const player = args.player || args.player_name;
        const text = args.text;
        if (!player || !text) return;
        this.bot.whisper(player, String(text));
    }

    async move_to(args = {}) {
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        if (![x, y, z].every(Number.isFinite)) {
            this.bot.chat('координаты не понял');
            return;
        }
        const goal = new goals.GoalBlock(x, y, z);
        this.bot.pathfinder.setGoal(goal);
    }

    async look_at(args = {}) {
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        if (![x, y, z].every(Number.isFinite)) return;
        await this.bot.lookAt(new Vec3(x, y, z));
    }

    async place_block(args = {}) {
        const { name } = args;
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        const hasTarget = [x, y, z].every(Number.isFinite);
        if (!name) {
            this.bot.chat('не понял что или куда ставить');
            return;
        }
        const item = this.bot.inventory.items().find(i => i.name === name);
        
        if (!item) {
            this.bot.chat(`нету ${name} для стройки`);
            return;
        }

        const tryPlaceAt = async (targetPos) => {
            const targetBlock = this.bot.blockAt(targetPos);
            if (!targetBlock) return false;
            const isAir = targetBlock.type === 0 || targetBlock.name.endsWith('air');
            if (!isAir) return false;

            const offsets = [
                new Vec3(0, -1, 0),
                new Vec3(0, 1, 0),
                new Vec3(1, 0, 0),
                new Vec3(-1, 0, 0),
                new Vec3(0, 0, 1),
                new Vec3(0, 0, -1)
            ];

            for (const offset of offsets) {
                const refPos = targetPos.plus(offset);
                const referenceBlock = this.bot.blockAt(refPos);
                if (!referenceBlock) continue;
                if (referenceBlock.boundingBox === 'empty') continue;

                const faceVector = targetPos.minus(refPos);
                const faceMagnitude = Math.abs(faceVector.x) + Math.abs(faceVector.y) + Math.abs(faceVector.z);
                if (faceMagnitude !== 1) continue;

                const dist = this.bot.entity.position.distanceTo(refPos);
                if (dist > 4.5) {
                    try {
                        await this.bot.pathfinder.goto(new goals.GoalNear(refPos.x, refPos.y, refPos.z, 2));
                    } catch (e) {
                        continue;
                    }
                }

                try {
                    await this.bot.equip(item, 'hand');
                    await this.bot.placeBlock(referenceBlock, faceVector);
                    memory.markBlockPlaced(targetPos, name, this.bot.username);
                    return true;
                } catch (e) {
                    logger.error(`Place block failed`, e);
                }
            }
            return false;
        };

        let placed = false;
        if (hasTarget) {
            const targetPos = new Vec3(x, y, z);
            placed = await tryPlaceAt(targetPos);
        }

        if (!placed) {
            const solids = this.bot.findBlocks({
                matching: (block) => block.type !== 0,
                maxDistance: 4,
                count: 30
            });
            for (const pos of solids) {
                const topPos = pos.offset(0, 1, 0);
                if (await tryPlaceAt(topPos)) {
                    placed = true;
                    break;
                }
            }
        }

        if (!placed) {
            this.bot.chat('не нашел место для блока');
        }
    }

    async reply_to(args = {}) {
        const { player, text } = args;
        if (!player || !text) return;
        this.bot.chat(`${player}, ${text}`);
    }

    async check_inventory() {
        // No-op, inventory is in context
        logger.info("Checked inventory (internal)");
    }

    async scan_surroundings() {
        // No-op, perception is in context
        logger.info("Scanned surroundings (internal)");
    }

    async equip(args = {}) {
        const { item_name, slot } = args;
        if (!item_name) {
            this.bot.chat('что надеть?');
            return;
        }
        const item = this.bot.inventory.items().find(i => i.name === item_name);
        if (!item) {
            this.bot.chat(`нет у меня ${item_name}`);
            return;
        }
        try {
            // map specific slots if needed, otherwise default
            const destination = slot === 'off-hand' ? 'off-hand' : 'hand'; 
            await this.bot.equip(item, destination);
        } catch (e) {
            logger.error(`Equip failed`, e);
            this.bot.chat(`не надевается чет`);
        }
    }

    async sleep() {
        const bed = this.bot.findBlock({
            matching: block => this.bot.isABed(block),
            maxDistance: 32
        });
        if (!bed) {
            this.bot.chat("кровати нет рядом");
            return;
        }
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
            await this.bot.sleep(bed);
            this.bot.chat("сплю... ззз");
        } catch (e) {
            this.bot.chat(`не спится: ${e.message}`);
        }
    }

    async wake() {
        try {
            await this.bot.wake();
        } catch (e) {
            // ignore
        }
    }

    async eat(args) {
        const { name } = args || {};
        const food = name 
            ? this.bot.inventory.items().find(i => i.name === name)
            : this.bot.inventory.items().find(i => i.food > 0);

        if (!food) {
            this.bot.chat("жрать нечего");
            return;
        }

        try {
            await this.bot.equip(food, 'hand');
            await this.bot.consume();
        } catch (e) {
            logger.error("Eat failed", e);
        }
    }

    async activate_block(args = {}) {
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        if (![x, y, z].every(Number.isFinite)) return;
        const block = this.bot.blockAt(new Vec3(x, y, z));
        if (!block) return;
        
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
            await this.bot.lookAt(block.position);
            await this.bot.activateBlock(block);
        } catch (e) {
            logger.error("Activate failed", e);
        }
    }

    async read_sign(args = {}) {
        const maxDistance = Number.isFinite(Number(args.maxDistance)) ? Number(args.maxDistance) : 6;
        const signBlock = this.bot.findBlock({
            matching: (block) => block && block.name && block.name.includes('sign'),
            maxDistance
        });
        if (!signBlock) {
            this.bot.chat('таблички не вижу');
            return;
        }
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(signBlock.position.x, signBlock.position.y, signBlock.position.z, 2));
            const text = this.extractSignText(signBlock);
            if (text) {
                memory.addWorldFact(`Табличка: ${text}`, 'sign');
                if (!args.silent) {
                    this.bot.chat(`табличка: ${text}`);
                }
            } else {
                this.bot.chat('не удалось прочитать табличку');
            }
        } catch (e) {
            logger.error('Read sign failed', e);
        }
    }

    extractSignText(block) {
        if (!block) return '';
        const raw = block.signText || block._signText || block.text || null;
        if (!raw && block.nbt && block.nbt.value && block.nbt.value.Text1) {
            try {
                const lines = ['Text1', 'Text2', 'Text3', 'Text4']
                    .map(key => block.nbt.value[key]?.value || '')
                    .filter(Boolean);
                return lines.join(' ').trim();
            } catch (e) {
                return '';
            }
        }
        if (Array.isArray(raw)) return raw.filter(Boolean).join(' ').trim();
        if (raw && typeof raw.getText === 'function') {
            const lines = raw.getText();
            if (Array.isArray(lines)) return lines.filter(Boolean).join(' ').trim();
        }
        if (raw && raw.lines && Array.isArray(raw.lines)) {
            return raw.lines.filter(Boolean).join(' ').trim();
        }
        if (typeof raw === 'string') return raw.trim();
        return '';
    }

    async open_door(args = {}) {
        const maxDistance = Number.isFinite(Number(args.maxDistance)) ? Number(args.maxDistance) : 4;
        const door = this.bot.findBlock({
            matching: (block) => {
                if (!block || !block.name) return false;
                return block.name.includes('door') || block.name.includes('trapdoor') || block.name.includes('gate');
            },
            maxDistance
        });

        if (!door) {
            this.bot.chat('двери не вижу рядом');
            return;
        }

        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(door.position.x, door.position.y, door.position.z, 2));
            if (typeof this.bot.openDoor === 'function') {
                await this.bot.openDoor(door);
            } else {
                await this.bot.activateBlock(door);
            }
        } catch (e) {
            logger.error('Open door failed', e);
        }
    }

    async pickup_item(args = {}) {
        const behavior = config.behavior || {};
        const radius = Number.isFinite(Number(args.radius))
            ? Number(args.radius)
            : (Number.isFinite(Number(behavior.scanRadiusDrops)) ? Number(behavior.scanRadiusDrops) : 18);
        const targetName = args.name ? this.normalizeItemName(args.name) : null;
        const entities = Object.values(this.bot.entities)
            .filter(e => e.type === 'object' && e.name === 'item')
            .map(e => ({ entity: e, name: this.getItemEntityName(e) }))
            .filter(entry => entry.entity.position.distanceTo(this.bot.entity.position) <= radius);

        const filtered = targetName
            ? entities.filter(entry => entry.name === targetName)
            : entities;
        if (filtered.length === 0) {
            this.bot.chat(targetName ? `не вижу ${targetName} рядом` : 'дропа не вижу рядом');
            return;
        }

        filtered.sort((a, b) => {
            const da = a.entity.position.distanceTo(this.bot.entity.position);
            const db = b.entity.position.distanceTo(this.bot.entity.position);
            return da - db;
        });
        const target = filtered[0].entity;
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        } catch (e) {
            logger.error('Pickup failed', e);
        }
    }

    async use_chest(args = {}) {
        const { action, item_name } = args;
        const x = Number(args.x);
        const y = Number(args.y);
        const z = Number(args.z);
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        if (!['deposit', 'withdraw'].includes(action)) return;
        if (!item_name || ![x, y, z].every(Number.isFinite)) return;
        // action: 'deposit' | 'withdraw'
        const chestBlock = this.bot.blockAt(new Vec3(x, y, z));
        if (!chestBlock) return;

        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
            const chest = await this.bot.openContainer(chestBlock);
            
            if (action === 'deposit') {
                const item = this.bot.inventory.items().find(i => i.name === item_name);
                if (item) await chest.deposit(item.type, null, count);
                else this.bot.chat(`нет у меня ${item_name} чтобы положить`);
            } else if (action === 'withdraw') {
                const item = chest.containerItems().find(i => i.name === item_name);
                if (item) await chest.withdraw(item.type, null, count);
                else this.bot.chat(`в сундуке нет ${item_name}`);
            }
            
            await new Promise(r => setTimeout(r, 500));
            chest.close();
        } catch (e) {
            logger.error("Chest op failed", e);
            this.bot.chat("сундук не открывается или запривачен");
        }
    }

    async mount(args = {}) {
        const { entity_type } = args; // e.g., 'boat', 'minecart', 'horse'
        if (!entity_type) return;
        const entity = this.bot.nearestEntity(e => e.name && e.name.toLowerCase().includes(entity_type));
        
        if (entity) {
            this.bot.mount(entity);
        } else {
            this.bot.chat(`не вижу ${entity_type}`);
        }
    }

    async dismount() {
        this.bot.dismount();
    }

    async wander(args = {}) {
        const rangeRaw = Number(args.range);
        const range = Number.isFinite(rangeRaw) ? Math.max(rangeRaw, 6) : 20;
        const bot = this.bot;

        const now = Date.now();
        if (bot.pathfinder.isMoving() && now - this.lastWanderAt < 8000) return;
        
        // Random angle and distance
        let targetX = bot.entity.position.x;
        let targetZ = bot.entity.position.z;
        let attempt = 0;
        while (attempt < 3) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 5 + Math.random() * (range - 5);
            targetX = bot.entity.position.x + Math.cos(angle) * dist;
            targetZ = bot.entity.position.z + Math.sin(angle) * dist;
            const candidate = new Vec3(targetX, bot.entity.position.y, targetZ);
            if (!this.lastWanderTarget || this.lastWanderTarget.distanceTo(candidate) > 3) {
                break;
            }
            attempt += 1;
        }
        
        // Use pathfinder to find a safe spot near there
        // GoalNear is flexible
        const goal = new goals.GoalNear(targetX, bot.entity.position.y, targetZ, 2);
        bot.pathfinder.setGoal(goal);
        
        // Optional: look where we are going
        bot.lookAt(new Vec3(targetX, bot.entity.position.y, targetZ));
        this.lastWanderAt = now;
        this.lastWanderTarget = new Vec3(targetX, bot.entity.position.y, targetZ);
    }

    async toss_all() {
        const items = this.bot.inventory.items();
        for (const item of items) {
            await this.bot.toss(item.type, null, item.count);
            await new Promise(r => setTimeout(r, 200));
        }
        this.bot.chat("я пустой теперь");
    }

    async follow(args = {}) {
        let targetName = args.targetName || args.entity_name || args.entity || args.name || args.player;
        
        let target = null;
        if (targetName && targetName.toLowerCase() !== 'player') {
             target = this.bot.players[targetName]?.entity;
        }
        
        // If specific target not found or generic request, find nearest player
        if (!target) {
            target = this.bot.nearestEntity(e => {
                if (e.type !== 'player') return false;
                const name = e.username || e.name;
                return !memory.isMuted(name);
            });
        }

        if (!target) {
            this.bot.chat("никого нет рядом чтобы идти");
            return;
        }

        const targetUsername = target.username || target.name || targetName;
        if (memory.isMuted(targetUsername)) {
            return;
        }
        
        let targetLabel = target.username || target.name || targetName || 'player';
        const now = Date.now();
        const windowMs = 15000;
        const entry = this.followHistory.get(targetLabel) || { count: 0, lastAt: 0 };
        if (now - entry.lastAt < windowMs) {
            entry.count += 1;
        } else {
            entry.count = 1;
        }
        entry.lastAt = now;
        this.followHistory.set(targetLabel, entry);

        if (entry.count >= 3) {
            const alt = this.bot.nearestEntity(e => {
                if (e.type !== 'player') return false;
                if (e === target) return false;
                const name = e.username || e.name;
                return !memory.isMuted(name);
            });
            if (alt) {
                target = alt;
                targetLabel = alt.username || alt.name || targetLabel;
                this.followHistory.set(targetLabel, { count: 1, lastAt: now });
            } else {
                return;
            }
        }

        const goal = new goals.GoalFollow(target, 2);
        this.bot.pathfinder.setGoal(goal, true);
    }

    stop() {
        this.bot.pathfinder.setGoal(null);
    }

    async mine_block(args = {}) {
        const { name } = args;
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        if (!name) {
            this.bot.chat('что копать?');
            return false;
        }
        const targetName = this.normalizeItemName(name);
        // Basic implementation - requires more complex logic for finding blocks
        const blocks = this.bot.findBlocks({
            matching: (block) => block.name === targetName,
            maxDistance: 32,
            count: count
        });

        const safeBlocks = blocks
            .map(pos => this.bot.blockAt(pos))
            .filter(block => block && this.isSafeToMine(block))
            .map(block => block.position);

        if (safeBlocks.length === 0) {
            this.bot.chat(`не вижу ${targetName} рядом`);
            return false;
        }

        for (const pos of safeBlocks) {
            const block = this.bot.blockAt(pos);
            if (block) {
                try {
                    // Collect block handles movement automatically
                    await this.bot.collectBlock.collect(block);
                } catch (e) {
                    logger.error(`Failed to mine ${name}`, e);
                    // If pathfinding failed, maybe wander a bit to unstuck
                    if (e.name === 'Timeout' || e.message.includes('path')) {
                        this.bot.chat("не могу добраться, ищу обход");
                    }
                }
            }
        }
        return true;
    }

    async placeBlockNear(itemName) {
        const item = this.bot.inventory.items().find(i => i.name === itemName);
        if (!item) return false;
        const below = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        if (below && below.boundingBox !== 'empty') {
            const above = this.bot.blockAt(below.position.offset(0, 1, 0));
            if (above && above.boundingBox === 'empty') {
                try {
                    await this.bot.equip(item, 'hand');
                    await this.bot.placeBlock(below, new Vec3(0, 1, 0));
                    memory.markBlockPlaced(below.position.offset(0, 1, 0), itemName, this.bot.username);
                    return true;
                } catch (e) {
                    logger.error('Place block near failed', e);
                }
            }
        }

        const support = this.bot.findBlock({
            matching: (block) => block && block.boundingBox !== 'empty',
            maxDistance: 3
        });
        if (!support) return false;
        const target = support.position.offset(0, 1, 0);
        const targetBlock = this.bot.blockAt(target);
        if (!targetBlock || targetBlock.boundingBox !== 'empty') return false;
        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(support.position.x, support.position.y, support.position.z, 2));
            await this.bot.equip(item, 'hand');
            await this.bot.placeBlock(support, new Vec3(0, 1, 0));
            memory.markBlockPlaced(support.position.offset(0, 1, 0), itemName, this.bot.username);
            return true;
        } catch (e) {
            logger.error('Place block near failed', e);
            return false;
        }
    }

    async ensureCraftingTable() {
        let table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 4 });
        if (table) return table;

        const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (!tableItem) {
            const crafted = await this.craft_item({ name: 'crafting_table', count: 1 });
            if (!crafted) return null;
        }

        const placed = await this.placeBlockNear('crafting_table');
        if (!placed) return null;
        table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 4 });
        return table;
    }

    async ensureFurnace() {
        const furnaceNames = ['furnace', 'lit_furnace'];
        const furnace = this.bot.findBlock({
            matching: (block) => block && furnaceNames.includes(block.name),
            maxDistance: 4
        });
        if (furnace) return furnace;

        const furnaceItem = this.bot.inventory.items().find(i => i.name === 'furnace');
        if (!furnaceItem) {
            const crafted = await this.craft_item({ name: 'furnace', count: 1 });
            if (!crafted) return null;
        }

        const placed = await this.placeBlockNear('furnace');
        if (!placed) return null;
        return this.bot.findBlock({
            matching: (block) => block && furnaceNames.includes(block.name),
            maxDistance: 4
        });
    }

    async craft_item(args = {}) {
        const { name } = args;
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        if (!name) return false;
        const targetName = this.normalizeItemName(name);
        logger.info(`Requested craft: ${targetName} x${count}`);
        
        // Anti-spam: check if we already have tool/table
        if (['crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'furnace'].includes(targetName)) {
            const hasItem = this.bot.inventory.items().find(i => i.name === targetName);
            if (hasItem) {
                logger.info(`Skipping craft ${targetName}, already have it`);
                return true;
            }
        }
        
        const itemData = this.bot.registry.itemsByName[targetName];
        if(!itemData) {
            this.bot.chat(`что такое ${targetName}? не знаю`);
            return false;
        }
        
        const recipes = this.bot.recipesFor(itemData.id, null, 1, null); // Check null world first (inv craft)
        let recipe = recipes[0];
        
        // If no inventory recipe, check crafting table recipes
        if (!recipe) {
             const craftingTableRecipes = this.bot.recipesFor(itemData.id, null, 1, true); // true = requires table
             recipe = craftingTableRecipes[0];
        }

        if(!recipe) {
            this.bot.chat(`не знаю как крафтить ${targetName} или нет ресов`);
            return false;
        }

        if (recipe.requiresTable) {
            const table = await this.ensureCraftingTable();
            if (!table) {
                this.bot.chat("нужен верстак рядом, не могу поставить");
                return false;
            }
            await this.bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
            try {
                await this.bot.craft(recipe, count, table);
                this.bot.chat(`скрафтил ${targetName}`);
                return true;
            } catch (e) {
                logger.error("Crafting table failed", e);
                this.bot.chat("не скрафтилось чет");
                return false;
            }
        }

        try {
            await this.bot.craft(recipe, count, null);
            this.bot.chat(`скрафтил ${targetName}`);
            return true;
        } catch(e) {
            logger.error("Crafting failed", e);
            this.bot.chat("ошибка крафта");
            return false;
        }
    }

    async use_furnace(args = {}) {
        const inputName = args.input_name || args.input || args.name;
        const fuelName = args.fuel_name || args.fuel;
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        if (!inputName) {
            this.bot.chat('что жарить?');
            return false;
        }
        const normalizedInput = this.normalizeItemName(inputName);
        const normalizedFuel = fuelName ? this.normalizeItemName(fuelName) : null;

        const furnaceBlock = await this.ensureFurnace();
        if (!furnaceBlock) {
            this.bot.chat('не могу найти или поставить печку');
            return false;
        }

        const inputItem = this.bot.inventory.items().find(i => i.name === normalizedInput);
        if (!inputItem) {
            this.bot.chat(`нет ${normalizedInput} для печки`);
            return false;
        }

        const fuelCandidates = normalizedFuel
            ? this.bot.inventory.items().filter(i => i.name === normalizedFuel)
            : this.bot.inventory.items().filter(i => {
                const name = i.name;
                return [
                    'coal', 'charcoal', 'coal_block', 'lava_bucket', 'stick',
                    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
                    'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem',
                    'warped_stem', 'oak_planks', 'spruce_planks', 'birch_planks',
                    'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
                    'cherry_planks', 'crimson_planks', 'warped_planks'
                ].includes(name);
            });

        const fuelItem = fuelCandidates[0];
        if (!fuelItem) {
            this.bot.chat('нет топлива для печки');
            return false;
        }

        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
            const furnace = await this.bot.openFurnace(furnaceBlock);
            if (furnace.outputItem()) {
                await furnace.takeOutput();
            }
            const inputCount = Math.min(count, inputItem.count);
            await furnace.putInput(inputItem.type, null, inputCount);
            const fuelCount = Math.min(fuelItem.count, Math.max(1, inputCount));
            await furnace.putFuel(fuelItem.type, null, fuelCount);
            furnace.close();
            this.bot.chat(`поставил ${normalizedInput} в печку`);
            return true;
        } catch (e) {
            logger.error('Furnace use failed', e);
            this.bot.chat('не получилось использовать печку');
            return false;
        }
    }

    async jump(args = {}) {
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        const total = Math.max(1, Math.min(count, 20));
        for (let i = 0; i < total; i += 1) {
            this.bot.setControlState('jump', true);
            await sleep(180);
            this.bot.setControlState('jump', false);
            await sleep(180);
        }
    }
    
    async attack_entity(args = {}) {
        const { name } = args;
        if (!name) return;
        const target = this.bot.nearestEntity(e => e.name === name || (e.username && e.username === name));
        if (target) {
            this.bot.pvp.attack(target);
        }
    }

    async give_item(args = {}) {
        const { player_name, item_name } = args;
        const count = Number.isFinite(Number(args.count)) ? Number(args.count) : 1;
        if (!player_name || !item_name) return false;
        const target = this.bot.players[player_name]?.entity;
        
        if (!target) {
            this.bot.chat(`не вижу где ${player_name}`);
            return false;
        }

        const normalizedItem = this.normalizeItemName(item_name);
        const item = this.bot.inventory.items().find(i => i.name === normalizedItem);
        if (!item) {
            this.bot.chat(`у меня нет ${normalizedItem}`);
            return false;
        }

        // Look at player
        await this.bot.lookAt(target.position.offset(0, target.height, 0));
        
        // Toss item
        try {
            await this.bot.toss(item.type, null, Math.min(count, item.count));
            return true;
        } catch (e) {
            logger.error(`Failed to give ${item_name}`, e);
            return false;
        }
    }

    async defend() {
        if (!this.bot.pvp) return;
        const target = this.bot.nearestEntity(e => e.type === 'mob' && e.position.distanceTo(this.bot.entity.position) < 8);
        if (!target) {
            this.bot.chat('тут тихо');
            return;
        }
        this.bot.pvp.attack(target);
    }
    
    get_status() {
        return {
            health: this.bot.health,
            food: this.bot.food,
            position: this.bot.entity.position,
            inventory: this.bot.inventory.items().map(i => `${i.name} x${i.count}`)
        };
    }
}

module.exports = Skills;
