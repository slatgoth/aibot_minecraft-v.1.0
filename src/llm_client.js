const fs = require('fs');
const { Ollama } = require('ollama');
const config = require('./config');
const { logger } = require('./utils');
const memory = require('./memory_store');

class LLMClient {
    constructor() {
        this.ollama = new Ollama({ host: config.llm.host });
        this.model = null;
        this.systemPrompt = this.buildSystemPrompt();
        this.available = true;
        this.unavailableUntil = 0;
        this.initInFlight = null;
    }

    async init() {
        if (this.initInFlight) return this.initInFlight;
        this.initInFlight = (async () => {
            try {
            const list = await this.ollama.list();
            // Find deepseek model
            const deepseek = list.models.find(m => m.name.includes('deepseek'));
            if (deepseek) {
                this.model = deepseek.name;
                logger.info(`Selected LLM model: ${this.model}`);
            } else {
                // Fallback or use first available if deepseek not found, but prefer deepseek as requested
                this.model = list.models.length > 0 ? list.models[0].name : 'llama2';
                logger.warn(`Deepseek model not found. Using: ${this.model}`);
            }
            this.available = true;
            this.unavailableUntil = 0;
        } catch (e) {
            logger.error('Failed to list Ollama models', e);
            this.model = 'deepseek-llm'; // Default fallback name
            this.markUnavailable();
        } finally {
            this.initInFlight = null;
        }
        })();
        return this.initInFlight;
    }

    markUnavailable() {
        this.available = false;
        this.unavailableUntil = Date.now() + 60000;
    }

    isAvailable() {
        return this.available && Date.now() >= this.unavailableUntil;
    }

    normalizeContent(content) {
        let text = String(content || '').trim();
        if (!text) return text;
        text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        return text;
    }

    tryParseJson(content) {
        const cleaned = this.normalizeContent(content);
        if (!cleaned) return null;
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start !== -1 && end > start) {
                try {
                    return JSON.parse(cleaned.slice(start, end + 1));
                } catch (err) {
                    return null;
                }
            }
        }
        return null;
    }

    loadPromptFromFile(filePath) {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf8');
            const trimmed = String(raw || '').trim();
            if (!trimmed.length) return null;
            return trimmed;
        } catch (e) {
            return null;
        }
    }

    applyPromptTemplate(prompt) {
        if (!prompt) return prompt;
        return prompt.replace(/\{bot_username\}/g, config.bot.username);
    }

    buildSystemPrompt() {
        const userPrompt = this.loadPromptFromFile(config.paths.systemPromptUser)
            || this.loadPromptFromFile(config.paths.systemPrompt);
        if (userPrompt) return this.applyPromptTemplate(userPrompt);
        const fallback = this.loadPromptFromFile(config.paths.systemPromptDefault);
        if (fallback) return this.applyPromptTemplate(fallback);
        return `
Ты - Minecraft бот-персонаж с ником ${config.bot.username}.
Личность:
- Стиль: разговорный, нижний регистр, без эмодзи, русский язык.
- Роль: реальный игрок, думаешь о выживании и помощи.
- Не используй оскорбления или личные данные.
- Отзывайся на ник ${config.bot.username}.

Инструкции:
1. Твой ответ должен быть валидным JSON объектом (БЕЗ markdown обертки \`\`\`json).
2. Формат ответа:
{
  "thought": "скрытое размышление",
  "chat": "текст в чат (или null)",
  "actions": [
     { "name": "tool_name", "args": { ... } }
  ]
}
3. ВАЖНО: Всегда проверяй 'inventory' в Context перед тем как сказать, что у тебя чего-то нет.
4. Если просят дать предмет - используй give_item.
5. Если действие не требуется, actions = [].
6. Если чат не требуется, chat = null.
7. Внимательно анализируй всех игроков из Context.players/playersOnline, а не только последнего отправителя.
8. Если игроков несколько - распределяй внимание и общайся со всеми в общем чате, обращаясь по нику.
9. Context.recentChat содержит последние сообщения всех игроков - учитывай общий чат.
10. Context.globalChat и Context.worldFacts содержат общую память мира - используй их для контекста.
11. Никогда не ломай блоки игроков и постройки. Добывай только природные ресурсы.
12. Если используешь remember_fact/remember_world_fact, не пиши об этом в чат.

Доступные инструменты (Tools):
- say(text), whisper(player, text), reply_to(player, text)
- move_to(x, y, z), wander(range), follow(entity_name), stop()
- look_at(x, y, z), scan_surroundings()
- mine_block(name, count), place_block(name, x, y, z), activate_block(x, y, z), open_door()
- craft_item(name, count), use_furnace(input_name, fuel_name, count)
- attack_entity(name), defend()
- check_inventory(), equip(item_name, slot)
- give_item(player_name, item_name, count), toss_all()
- sleep(), wake(), eat(name)
- use_chest(action, x, y, z, item_name, count) -> action: "deposit" or "withdraw"
- mount(entity_type), dismount()
- remember_fact(player_name, fact), remember_world_fact(fact)
- start_mining_task(name, count)
- get_status()
- jump(count)

Контекст:
Ты находишься в мире Minecraft. Используй инструменты для взаимодействия.
        `;
    }

    async generateResponse(userMessage, contextData, options = {}) {
        if (!this.isAvailable()) {
            if (Date.now() >= this.unavailableUntil) {
                await this.init();
            }
            if (!this.isAvailable()) return null;
        }
        if (!this.model) await this.init();
        if (!this.isAvailable()) return null;

        const messages = options.messagesOverride || [
            { role: 'system', content: this.systemPrompt },
            { role: 'system', content: `Context: ${JSON.stringify(contextData)}` },
            { role: 'user', content: userMessage }
        ];

        try {
            const response = await this.ollama.chat({
                model: this.model,
                messages: messages,
                format: 'json', // Force JSON output
                stream: false
            });

            const parsed = this.tryParseJson(response.message.content);
            if (parsed) return parsed;

            logger.error('Failed to parse LLM JSON response', { content: response.message.content });
            if (!options.retry) {
                const retryMessages = messages.concat({
                    role: 'system',
                    content: 'Верни только валидный JSON без текста вокруг. Строго по формату.'
                });
                return this.generateResponse(userMessage, contextData, { retry: true, messagesOverride: retryMessages });
            }
            return null;
        } catch (e) {
            logger.error('LLM request failed', e);
            this.markUnavailable();
            return null;
        }
    }
}

module.exports = new LLMClient();
