const { logger } = require('./utils');
const config = require('./config');
const memory = require('./memory_store');

class ChatHandler {
    constructor(bot, planner) {
        this.bot = bot;
        this.planner = planner;
        this.lastUserRequestAt = new Map();
        this.lastGlobalRequestAt = 0;
    }

    isMuteRequest(messageLower, isAddressed, isMentioned) {
        if (!isAddressed && !isMentioned) return false;
        const triggers = [
            'заткнись',
            'замолчи',
            'молчи',
            'не пиши',
            'не говори',
            'отстань',
            'хватит',
            'не трогай',
            'не подходи',
            'не лезь',
            'shut up'
        ];
        return triggers.some(t => messageLower.includes(t));
    }

    isOnCooldown(username) {
        const cooldownMs = config.behavior.chatCooldown || 0;
        const globalCooldownMs = config.behavior.globalChatCooldown || 0;
        if (cooldownMs <= 0) return false;
        const now = Date.now();
        if (globalCooldownMs > 0 && now - this.lastGlobalRequestAt < globalCooldownMs) return true;
        const lastUserAt = this.lastUserRequestAt.get(username) || 0;
        return now - lastUserAt < cooldownMs;
    }

    markRequest(username) {
        const now = Date.now();
        this.lastGlobalRequestAt = now;
        this.lastUserRequestAt.set(username, now);
    }

    init() {
        if (this._onChat) return;
        this._onChat = async (username, message) => {
            if (username === this.bot.username) return;

            logger.info(`Chat in: <${username}> ${message}`);
            memory.logInteraction(username, 'chat', message);

            // Command handling
            const msgLower = message.toLowerCase();
            const prefixes = (config.behavior.commandPrefixes && config.behavior.commandPrefixes.length > 0)
                ? config.behavior.commandPrefixes
                : [`${this.bot.username},`];
            const isAddressed = prefixes.some(prefix => msgLower.startsWith(String(prefix).toLowerCase()));
            const isMentioned = message.includes(this.bot.username);
            const allowGeneral = this.planner.mode !== 'manual';

            if (this.isMuteRequest(msgLower, isAddressed, isMentioned)) {
                const minutes = config.behavior.etiquetteMuteMinutes || 10;
                memory.setMuted(username, minutes * 60000);
                if (isAddressed || isMentioned) {
                    this.bot.chat(`${username}, ок, приторможу на ${minutes} мин`);
                }
                return;
            }

            if (isAddressed) {
                if (this.isOnCooldown(username)) {
                    logger.info(`Chat cooldown active for ${username}`);
                    return;
                }
                this.markRequest(username);
                const jumpMatch = msgLower.match(/прыгай\s*(\d+)?/);
                if (jumpMatch) {
                    const count = jumpMatch[1] ? Number(jumpMatch[1]) : 1;
                    await this.planner.skills.jump({ count });
                    return;
                }
                if (msgLower.includes('открой дверь') || msgLower.includes('открой двери')) {
                    await this.planner.skills.open_door({});
                    return;
                }
                if (msgLower.includes('прочитай табличку') || msgLower.includes('прочитай таблички')) {
                    await this.planner.skills.read_sign({});
                    return;
                }
                const woodMatch = msgLower.match(/(дров|бревен|брёвен|бревна|бревно|дерева)\s*(\d+)?/);
                if (woodMatch) {
                    const amount = woodMatch[2] ? Number(woodMatch[2]) : 32;
                    this.planner.taskManager.startTask({ type: 'gather_wood', amount });
                    this.bot.chat(`иду за дровами (${amount})`);
                    return;
                }
                if (msgLower.includes('ферм') || msgLower.includes('огород')) {
                    this.planner.taskManager.startTask({ type: 'farm' });
                    this.bot.chat('занимаюсь фермой');
                    return;
                }
                if (msgLower.includes('режим выживания')) {
                    this.planner.setMode('survival');
                    this.bot.chat('ладно, включаю режим выживания. не мешайте, я развиваюсь.');
                    return;
                }
                if (msgLower.includes('режим автономный') || msgLower.includes('автономный режим') || msgLower.includes('режим авто')) {
                    this.planner.setMode('autonomous');
                    this.bot.chat('ок, автономный режим. щас наведу суеты.');
                    return;
                }
                if (msgLower.includes('режим ручной') || msgLower.includes('ручной режим') || msgLower.includes('режим мануальный')) {
                    this.planner.setMode('manual');
                    this.bot.chat('ручной режим. слушаю команды.');
                    return;
                }
                await this.planner.processUserRequest(username, message);
            } else if (isMentioned) {
                // Mentioned
                if (this.isOnCooldown(username)) {
                    logger.info(`Chat cooldown active for ${username}`);
                    return;
                }
                this.markRequest(username);
                await this.planner.processUserRequest(username, message);
            } else if (allowGeneral) {
                if (memory.isMuted(username)) {
                    logger.info(`Muted user ignored: ${username}`);
                    return;
                }
                if (this.isOnCooldown(username)) {
                    logger.info(`Chat cooldown active for ${username}`);
                    return;
                }
                this.markRequest(username);
                await this.planner.processUserRequest(username, message, { passive: true });
            }
        };
        this.bot.on('chat', this._onChat);
    }

    stop() {
        if (!this._onChat) return;
        this.bot.removeListener('chat', this._onChat);
        this._onChat = null;
    }
}

module.exports = ChatHandler;
