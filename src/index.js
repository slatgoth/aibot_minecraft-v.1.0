const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const armorManager = require('mineflayer-armor-manager');
const autoEat = require('mineflayer-auto-eat').plugin;
const collectBlock = require('mineflayer-collectblock').plugin;

const config = require('./config');
const { logger } = require('./utils');
const Skills = require('./skills');
const Perception = require('./perception');
const Planner = require('./planner');
const ChatHandler = require('./chat');
const llm = require('./llm_client');
const Reflexes = require('./reflexes');
const Observer = require('./observer');

let bot = null;
let planner = null;
let skills = null;
let perception = null;
let pendingMode = null;
let idleInterval = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let shuttingDown = false;

const formatKickReason = (reason) => {
    if (!reason) return 'kicked';
    if (typeof reason === 'string') return reason;
    if (reason && typeof reason === 'object' && typeof reason.text === 'string') return reason.text;
    try {
        return JSON.stringify(reason);
    } catch (e) {
        return String(reason);
    }
};

const formatErrorMessage = (err) => {
    if (!err) return 'error';
    if (typeof err === 'string') return err;
    const code = err.code ? `${err.code}: ` : '';
    const message = err.message || err.reason || err.toString();
    if (err.code === 'ECONNRESET') {
        return `${code}${message} (проверь ViaProxy target-address и версию сервера)`;
    }
    return `${code}${message || 'error'}`;
};

const getConnectionConfig = () => {
    const connection = config.connection || {};
    return {
        autoReconnect: connection.autoReconnect !== false,
        reconnectDelayMs: Number.isFinite(Number(connection.reconnectDelayMs))
            ? Number(connection.reconnectDelayMs)
            : 5000,
        maxReconnectAttempts: Number.isFinite(Number(connection.maxReconnectAttempts))
            ? Number(connection.maxReconnectAttempts)
            : 0
    };
};

const cleanupBot = () => {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = null;
    bot = null;
    planner = null;
    skills = null;
    perception = null;
};

const scheduleReconnect = (reason) => {
    if (shuttingDown) return;
    const { autoReconnect, reconnectDelayMs, maxReconnectAttempts } = getConnectionConfig();
    if (!autoReconnect) return;
    if (maxReconnectAttempts > 0 && reconnectAttempts >= maxReconnectAttempts) {
        logger.warn('Reconnect attempts limit reached');
        return;
    }
    reconnectAttempts += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    logger.warn(`Reconnecting in ${reconnectDelayMs}ms (reason: ${reason || 'unknown'})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        createBot();
    }, reconnectDelayMs);
};

const sendToParent = (payload) => {
    if (typeof process.send === 'function') {
        process.send(payload);
    }
};

const getStatus = () => {
    if (!bot) {
        return { running: false };
    }
    const pos = bot.entity ? bot.entity.position : null;
    return {
        running: true,
        username: bot.username,
        mode: planner ? planner.mode : null,
        spawned: !!bot.entity,
        health: bot.health,
        food: bot.food,
        position: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null
    };
};

function createBot() {
    if (bot) return bot;
    shuttingDown = false;
    logger.info('Starting bot...');
    reconnectAttempts = 0;

    bot = mineflayer.createBot({
        host: config.bot.host,
        port: config.bot.port,
        username: config.bot.username,
        version: config.bot.version, // Connection version (1.21.4 for ViaProxy)
        auth: config.bot.auth
    });

    // Load plugins
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    // bot.loadPlugin(armorManager); // Disabled due to crash
    bot.loadPlugin(autoEat);
    bot.loadPlugin(collectBlock);

    // Initialize modules once spawned
    bot.once('spawn', () => {
        logger.info('Bot spawned!');
        reconnectAttempts = 0;

        const mcData = require('minecraft-data')(bot.version);
        const defaultMove = new Movements(bot, mcData);
        bot.pathfinder.setMovements(defaultMove);

        skills = new Skills(bot);
        perception = new Perception(bot);
        planner = new Planner(bot, skills, perception);
        const chatHandler = new ChatHandler(bot, planner);
        const reflexes = new Reflexes(bot, planner);
        const observer = new Observer(bot);

        chatHandler.init();
        planner.start();
        reflexes.start();
        observer.start();

        if (pendingMode) {
            planner.setMode(pendingMode);
            pendingMode = null;
        }

        // Init LLM
        llm.init().then(() => logger.info('LLM initialized'));

        // Idle behavior: Look at nearest player
        idleInterval = setInterval(() => {
            if (bot.pathfinder.isMoving()) return;

            const entity = bot.nearestEntity(e => e.type === 'player');
            if (entity && entity.position.distanceTo(bot.entity.position) < 5) {
                bot.lookAt(entity.position.offset(0, entity.height, 0));
            }
        }, 100);

        bot.on('death', () => {
            logger.warn('Bot died');
        });

        sendToParent({ type: 'bot_status', data: getStatus() });
    });

    bot.on('kicked', (reason) => {
        logger.error('Bot kicked', reason);
        sendToParent({ type: 'bot_error', error: formatKickReason(reason) });
        sendToParent({ type: 'bot_status', data: getStatus() });
        cleanupBot();
        scheduleReconnect('kicked');
    });
    bot.on('error', (err) => {
        logger.error('Bot error', err);
        sendToParent({ type: 'bot_error', error: formatErrorMessage(err) });
        sendToParent({ type: 'bot_status', data: getStatus() });
        cleanupBot();
        scheduleReconnect(err && err.code ? err.code : 'error');
    });
    bot.on('end', () => {
        cleanupBot();
        sendToParent({ type: 'bot_status', data: getStatus() });
        scheduleReconnect('end');
    });

    return bot;
}

const setMode = (mode) => {
    if (planner) {
        planner.setMode(mode);
        sendToParent({ type: 'bot_status', data: getStatus() });
        return true;
    }
    pendingMode = mode;
    return false;
};

const handleCommand = async (message) => {
    if (!message || typeof message !== 'object') return;
    const { type, payload, requestId } = message;

    if (type === 'get_status') {
        sendToParent({ type: 'bot_status', data: getStatus(), requestId });
        return;
    }

    if (!bot) {
        sendToParent({ type: 'bot_error', error: 'bot not running', requestId });
        return;
    }

    if (type === 'chat') {
        if (payload && payload.text) {
            bot.chat(String(payload.text));
        }
    } else if (type === 'set_mode') {
        const mode = payload && payload.mode;
        if (mode) setMode(mode);
    } else if (type === 'stop_tasks') {
        if (planner && planner.taskManager) {
            planner.taskManager.stopTask();
        }
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
    } else if (type === 'reload_prompt') {
        llm.systemPrompt = llm.buildSystemPrompt();
        sendToParent({ type: 'bot_status', data: getStatus() });
    } else if (type === 'shutdown') {
        shuttingDown = true;
        bot.quit('shutdown');
    } else if (type === 'user_command') {
        const text = payload && payload.text;
        if (text && planner) {
            await planner.processUserRequest('panel', text);
        }
    }
};

process.on('message', (message) => {
    handleCommand(message).catch((err) => {
        logger.error('Command handling failed', err);
    });
});

if (require.main === module) {
    createBot();
}
