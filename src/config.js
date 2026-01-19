const fs = require('fs');
const path = require('path');

const envInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const envNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const repoRoot = path.join(__dirname, '..');

const getUserDataRoot = () => {
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'minecraft-llm-bot');
    }
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) return path.join(home, 'minecraft-llm-bot');
    return null;
};

const userDataRoot = getUserDataRoot();
const configPathRepo = path.join(repoRoot, 'config.user.json');
const configPathUserData = userDataRoot ? path.join(userDataRoot, 'config.user.json') : null;
const dataRoot = process.env.BOT_DATA_ROOT
    ? path.resolve(process.env.BOT_DATA_ROOT)
    : (userDataRoot ? path.join(userDataRoot, 'data') : path.join(repoRoot, 'data'));
const logsRoot = process.env.BOT_LOGS_ROOT
    ? path.resolve(process.env.BOT_LOGS_ROOT)
    : (userDataRoot ? path.join(userDataRoot, 'logs') : path.join(repoRoot, 'logs'));

const baseConfig = {
    bot: {
        host: 'localhost', // Connected via local proxy port usually
        port: 25568,       // Proxy port configured in viaproxy.yml
        username: 'bot',
        version: '1.21.4', // Connection version (proxy handles target)
        auth: 'offline'
    },
    proxy: {
        // Proxy target for reference (optional)
        targetHost: 'example.com',
        targetPort: 25565
    },
    llm: {
        host: 'http://127.0.0.1:11434',
        defaultModel: 'deepseek-llm', // Will be auto-detected
        contextWindow: 8192,
        temperature: 0.7
    },
    viaProxy: {
        root: '',
        jar: '',
        javaPath: '',
        args: '',
        autoStart: true,
        syncConfig: true
    },
    connection: {
        autoReconnect: true,
        reconnectDelayMs: 5000,
        maxReconnectAttempts: 0
    },
    launcher: {
        autoStartBot: true,
        waitForProxy: true,
        waitForProxyTimeoutMs: 15000
    },
    paths: {
        memory: path.join(dataRoot, 'memory.json'),
        logs: logsRoot,
        items: path.join(repoRoot, 'data/minecraft_1.21.11_blocks_items_en.json'),
        recipes: path.join(repoRoot, 'data/mineflayer_recipes_minecraft_1.21.11.json'),
        systemPromptDefault: path.join(repoRoot, 'prompts/system_prompt.default.txt'),
        systemPrompt: path.join(repoRoot, 'prompts/system_prompt.txt'),
        systemPromptUser: userDataRoot ? path.join(userDataRoot, 'system_prompt.txt') : null,
        userConfig: configPathRepo,
        userConfigAlt: configPathUserData
    },
    behavior: {
        defaultMode: 'manual', // 'manual' or 'autonomous'
        commandPrefixes: ['bot,'],
        chatCooldown: 5000,
        globalChatCooldown: 0,
        maxChatHistory: 20,
        socialRoundInterval: 500000,
        perPlayerChatCooldown: 120000,
        maxFactsPerPlayer: 50,
        etiquetteMuteMinutes: 10
    }
};

const loadUserConfig = (filePath) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
};

const deepMerge = (target, source) => {
    if (!source || typeof source !== 'object') return target;
    const output = Array.isArray(target) ? [...target] : { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (Array.isArray(value)) {
            output[key] = value.slice();
            continue;
        }
        if (value && typeof value === 'object' && typeof output[key] === 'object') {
            output[key] = deepMerge(output[key], value);
            continue;
        }
        output[key] = value;
    }
    return output;
};

const normalizePrefixes = (prefixes) => {
    if (!prefixes) return baseConfig.behavior.commandPrefixes;
    if (Array.isArray(prefixes)) {
        const cleaned = prefixes.map(p => String(p || '').trim()).filter(Boolean);
        return cleaned.length ? cleaned : baseConfig.behavior.commandPrefixes;
    }
    const asString = String(prefixes || '').trim();
    if (!asString) return baseConfig.behavior.commandPrefixes;
    return asString.split(',').map(p => p.trim()).filter(Boolean);
};

const applyEnvOverrides = (config) => {
    if (process.env.BOT_HOST) config.bot.host = process.env.BOT_HOST;
    if (process.env.BOT_PORT) config.bot.port = envInt(process.env.BOT_PORT, config.bot.port);
    if (process.env.BOT_USERNAME) config.bot.username = process.env.BOT_USERNAME;
    if (process.env.BOT_VERSION) config.bot.version = process.env.BOT_VERSION;
    if (process.env.BOT_AUTH) config.bot.auth = process.env.BOT_AUTH;

    if (process.env.MC_SERVER_HOST) config.proxy.targetHost = process.env.MC_SERVER_HOST;
    if (process.env.MC_SERVER_PORT) config.proxy.targetPort = envInt(process.env.MC_SERVER_PORT, config.proxy.targetPort);

    if (process.env.OLLAMA_HOST) config.llm.host = process.env.OLLAMA_HOST;
    if (process.env.OLLAMA_MODEL) config.llm.defaultModel = process.env.OLLAMA_MODEL;
    if (process.env.OLLAMA_CONTEXT) config.llm.contextWindow = envInt(process.env.OLLAMA_CONTEXT, config.llm.contextWindow);
    if (process.env.OLLAMA_TEMPERATURE) config.llm.temperature = envNumber(process.env.OLLAMA_TEMPERATURE, config.llm.temperature);
};

const envConfigPath = process.env.BOT_CONFIG_PATH ? path.resolve(process.env.BOT_CONFIG_PATH) : null;
const resolvedConfigPath = (() => {
    if (envConfigPath && fs.existsSync(envConfigPath)) return envConfigPath;
    if (configPathUserData && fs.existsSync(configPathUserData)) return configPathUserData;
    if (fs.existsSync(configPathRepo)) return configPathRepo;
    return envConfigPath || configPathUserData || configPathRepo;
})();

const userConfig = loadUserConfig(resolvedConfigPath);
const merged = deepMerge(baseConfig, userConfig);
applyEnvOverrides(merged);
merged.behavior.commandPrefixes = normalizePrefixes(merged.behavior.commandPrefixes);

module.exports = merged;
