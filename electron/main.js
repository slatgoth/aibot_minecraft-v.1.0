const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFile, fork, spawn } = require('child_process');

const config = require('../src/config');

const appDataRoot = app.getPath('appData');
const userDataRoot = path.join(appDataRoot, 'minecraft-llm-bot');
const viaProxyUserRoot = path.join(userDataRoot, 'viaproxy');
const configPath = path.join(userDataRoot, 'config.user.json');
const promptDefaultPath = path.join(app.getAppPath(), 'prompts', 'system_prompt.default.txt');
const promptUserPath = path.join(userDataRoot, 'system_prompt.txt');

const getResourceRoot = () => (app.isPackaged ? process.resourcesPath : app.getAppPath());
const resourceViaProxyRoot = app.isPackaged
    ? path.join(getResourceRoot(), 'viaproxy')
    : path.join(getResourceRoot(), 'tools', 'viaproxy');

let mainWindow = null;
let currentConfig = config;
let botProcess = null;
let botStatus = { running: false };
let viaProxyProcess = null;

const readFileSafe = (filePath) => {
    try {
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
};

const writeFileSafe = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
};

const writeJsonSafe = (filePath, data) => {
    const serialized = JSON.stringify(data, null, 2);
    writeFileSafe(filePath, serialized);
};

const copyDirRecursive = (source, target) => {
    if (!source || !fs.existsSync(source)) return;
    fs.mkdirSync(target, { recursive: true });
    const entries = fs.readdirSync(source, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, targetPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, targetPath);
        }
    }
};

const isWritableDir = (dirPath) => {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
};

const ensureViaProxyRoot = () => {
    if (!resourceViaProxyRoot || !fs.existsSync(resourceViaProxyRoot)) {
        return resourceViaProxyRoot;
    }
    if (fs.existsSync(viaProxyUserRoot) && fs.existsSync(path.join(viaProxyUserRoot, 'viaproxy.yml'))) {
        return viaProxyUserRoot;
    }
    copyDirRecursive(resourceViaProxyRoot, viaProxyUserRoot);
    return viaProxyUserRoot;
};

const resolveViaProxyRoot = (root) => {
    if (root && fs.existsSync(root)) {
        if (app.isPackaged && root.startsWith(process.resourcesPath)) {
            return ensureViaProxyRoot();
        }
        if (isWritableDir(root)) return root;
        return ensureViaProxyRoot();
    }
    if (app.isPackaged) {
        return ensureViaProxyRoot();
    }
    return resourceViaProxyRoot;
};

const stripProtocol = (value) => String(value || '').replace(/^https?:\/\//i, '').trim();

const formatAddress = (host, port) => {
    const cleanHost = stripProtocol(host);
    const cleanPort = Number(port);
    if (!cleanHost || !Number.isFinite(cleanPort)) return null;
    return `${cleanHost}:${cleanPort}`;
};

const parseAddress = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return { host: '', port: null };
    const parts = raw.split(':');
    if (parts.length < 2) return { host: raw, port: null };
    const port = Number(parts.pop());
    const host = parts.join(':');
    return { host, port: Number.isFinite(port) ? port : null };
};

const readViaProxyConfig = (root) => {
    try {
        if (!root) return null;
        const filePath = path.join(root, 'viaproxy.yml');
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const config = {};
        raw.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
            if (!match) return;
            let value = match[2].trim();
            value = value.replace(/^['"]|['"]$/g, '');
            config[match[1]] = value;
        });
        return config;
    } catch (e) {
        return null;
    }
};

const updateViaProxyConfig = (root, updates) => {
    try {
        if (!root) return { ok: false, error: 'ViaProxy root missing' };
        const filePath = path.join(root, 'viaproxy.yml');
        if (!fs.existsSync(filePath)) return { ok: false, error: 'viaproxy.yml not found' };
        const raw = fs.readFileSync(filePath, 'utf8');
        const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
        let lines = raw.split(/\r?\n/);
        let changed = false;

        Object.entries(updates).forEach(([key, value]) => {
            if (!value) return;
            let found = false;
            const keyPattern = new RegExp(`^\\s*${key}\\s*:`, 'i');
            lines = lines.map((line) => {
                if (keyPattern.test(line) && !line.trim().startsWith('#')) {
                    found = true;
                    const nextLine = `${key}: ${value}`;
                    if (line.trim() !== nextLine) {
                        changed = true;
                        return nextLine;
                    }
                }
                return line;
            });
            if (!found) {
                lines.push(`${key}: ${value}`);
                changed = true;
            }
        });

        if (changed) {
            fs.writeFileSync(filePath, lines.join(lineEnding), 'utf8');
        }
        return { ok: true, changed };
    } catch (e) {
        return { ok: false, error: e.message };
    }
};

const syncViaProxyConfig = (root, botConfig, proxyConfig) => {
    const bindAddress = formatAddress(botConfig.host, botConfig.port);
    const targetAddress = formatAddress(proxyConfig.targetHost, proxyConfig.targetPort);
    if (!bindAddress || !targetAddress) return { ok: true, skipped: true };
    return updateViaProxyConfig(root, {
        'bind-address': bindAddress,
        'target-address': targetAddress
    });
};

const normalizeUrl = (raw) => {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return `http://${trimmed}`;
};

const fetchWithTimeout = async (url, timeoutMs = 2000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timer);
    }
};

const listModelsViaApi = async (host) => {
    const normalized = normalizeUrl(host);
    if (!normalized) throw new Error('OLLAMA_HOST is empty');
    const response = await fetchWithTimeout(`${normalized.replace(/\/$/, '')}/api/tags`, 2500);
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map(m => m.name).filter(Boolean) : [];
    return models;
};

const listModelsViaCli = async () => {
    return new Promise((resolve) => {
        execFile('ollama', ['list'], { timeout: 5000 }, (err, stdout) => {
            if (err) {
                resolve({ models: [], error: err.message });
                return;
            }
            const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
            if (lines.length <= 1) {
                resolve({ models: [] });
                return;
            }
            const models = lines.slice(1).map(line => line.split(/\s+/)[0]).filter(Boolean);
            resolve({ models });
        });
    });
};

const checkTcp = async (host, port) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve({ ok, error });
        };
        socket.setTimeout(1500);
        socket.on('connect', () => finish(true, null));
        socket.on('timeout', () => finish(false, 'timeout'));
        socket.on('error', (err) => finish(false, err.message));
        socket.connect(Number(port), host);
    });
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitForPort = async (host, port, timeoutMs = 15000, intervalMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await checkTcp(host, port);
        if (result.ok) return true;
        await sleep(intervalMs);
    }
    return false;
};

const findViaProxyJar = (root) => {
    try {
        if (!root || !fs.existsSync(root)) return null;
        const entries = fs.readdirSync(root);
        const jar = entries.find(name => /^ViaProxy-.*\.jar$/i.test(name)) || entries.find(name => /\.jar$/i.test(name));
        return jar ? path.join(root, jar) : null;
    } catch (e) {
        return null;
    }
};

const getViaProxySettings = () => {
    const viaProxy = currentConfig.viaProxy || {};
    let root = resolveViaProxyRoot(viaProxy.root || viaProxy.path || '');
    let jar = viaProxy.jar || '';
    if (!jar || !fs.existsSync(jar)) {
        jar = findViaProxyJar(root);
    }
    const javaPath = viaProxy.javaPath || 'java';
    const argsRaw = viaProxy.args || '';
    const args = Array.isArray(argsRaw)
        ? argsRaw
        : String(argsRaw)
            .split(' ')
            .map(arg => arg.trim())
            .filter(Boolean);
    const autoStart = Boolean(viaProxy.autoStart);
    const syncConfig = viaProxy.syncConfig !== false;
    return { root, jar, javaPath, args, autoStart, syncConfig };
};

const startViaProxy = () => {
    if (viaProxyProcess) return { ok: true, status: 'already_running' };
    const settings = getViaProxySettings();
    if (settings.syncConfig) {
        const syncResult = syncViaProxyConfig(
            settings.root,
            currentConfig.bot || config.bot,
            currentConfig.proxy || config.proxy
        );
        if (!syncResult.ok && !syncResult.skipped) {
            return { ok: false, error: syncResult.error || 'ViaProxy config sync failed' };
        }
    }
    if (!settings.jar) {
        return { ok: false, error: 'ViaProxy jar not found' };
    }
    viaProxyProcess = spawn(settings.javaPath, ['-jar', settings.jar, ...settings.args], {
        cwd: settings.root,
        stdio: 'pipe'
    });
    viaProxyProcess.once('error', (err) => {
        viaProxyProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('proxy-error', { error: err.message });
        }
    });
    viaProxyProcess.on('exit', (code, signal) => {
        viaProxyProcess = null;
        if (mainWindow && code) {
            mainWindow.webContents.send('proxy-error', { error: `ViaProxy exited (${code || signal || 'unknown'})` });
        }
    });
    return { ok: true, status: 'started' };
};

const stopViaProxy = () => {
    if (!viaProxyProcess) return { ok: true, status: 'not_running' };
    viaProxyProcess.kill();
    viaProxyProcess = null;
    return { ok: true, status: 'stopped' };
};

const getBotEntry = () => path.join(app.getAppPath(), 'src', 'index.js');

const startBot = async () => {
    if (botProcess) return { ok: true, status: 'already_running' };
    const botConfig = currentConfig.bot || config.bot;
    const launcher = currentConfig.launcher || {};
    const proxySettings = getViaProxySettings();
    const proxyConfig = readViaProxyConfig(proxySettings.root);
    if (proxyConfig) {
        const bind = parseAddress(proxyConfig['bind-address']);
        const targetAddress = proxyConfig['target-address'] || '';
        const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);
        const usesProxy = bind.port && Number(botConfig.port) === bind.port && localHosts.has(String(botConfig.host || ''));
        if (usesProxy && (!targetAddress || targetAddress.includes('example.com'))) {
            return { ok: false, error: 'ViaProxy target-address не настроен' };
        }
    }
    const waitForProxy = launcher.waitForProxy !== false;
    const waitTimeout = Number.isFinite(Number(launcher.waitForProxyTimeoutMs))
        ? Number(launcher.waitForProxyTimeoutMs)
        : 15000;
    if (waitForProxy) {
        const ready = await waitForPort(botConfig.host, botConfig.port, waitTimeout, 1000);
        if (!ready) {
            return { ok: false, error: 'proxy/port not ready' };
        }
    }
    const entry = getBotEntry();
    botProcess = fork(entry, [], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            BOT_CONFIG_PATH: configPath
        },
        execPath: process.execPath,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    botProcess.once('error', (err) => {
        botProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('bot-error', { error: err.message });
        }
    });
    botProcess.on('message', (msg) => {
        if (msg && msg.type === 'bot_status') {
            botStatus = msg.data || botStatus;
            if (mainWindow) {
                mainWindow.webContents.send('bot-status', botStatus);
            }
        }
    });
    botProcess.on('exit', () => {
        botProcess = null;
        botStatus = { running: false };
        if (mainWindow) {
            mainWindow.webContents.send('bot-status', botStatus);
        }
    });
    return { ok: true, status: 'started' };
};

const startBotWithProxy = async () => {
    if (getViaProxySettings().autoStart) {
        const proxyResult = startViaProxy();
        if (!proxyResult.ok) {
            if (mainWindow) {
                mainWindow.webContents.send('proxy-error', { error: proxyResult.error || 'ViaProxy start failed' });
            }
        }
    }
    return startBot();
};

const stopBot = () => {
    if (!botProcess) return { ok: true, status: 'not_running' };
    botProcess.send({ type: 'shutdown' });
    setTimeout(() => {
        if (botProcess) {
            botProcess.kill('SIGKILL');
        }
    }, 3000);
    return { ok: true, status: 'stopping' };
};

const waitForBotExit = (timeoutMs = 5000) => {
    return new Promise((resolve) => {
        if (!botProcess) {
            resolve(true);
            return;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve(true);
        };
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(false);
        }, timeoutMs);
        botProcess.once('exit', () => {
            clearTimeout(timer);
            finish();
        });
    });
};

const restartBot = async () => {
    if (!botProcess) {
        return startBot();
    }
    stopBot();
    await waitForBotExit(6000);
    return startBot();
};

const sendBotCommand = (type, payload = {}) => {
    if (!botProcess) return { ok: false, error: 'bot not running' };
    botProcess.send({ type, payload });
    return { ok: true };
};

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1020,
        height: 900,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    if (currentConfig.launcher && currentConfig.launcher.autoStartBot) {
        startBotWithProxy().catch(() => {});
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', async () => {
    const defaultRoot = resolveViaProxyRoot('');
    return {
        config: currentConfig,
        configPath,
        defaults: {
            viaProxyRoot: defaultRoot,
            viaProxyJar: findViaProxyJar(defaultRoot)
        }
    };
});

ipcMain.handle('save-config', async (_, payload) => {
    currentConfig = payload;
    writeJsonSafe(configPath, payload);
    let syncResult = null;
    if (payload && payload.viaProxy && payload.viaProxy.syncConfig !== false) {
        const settings = getViaProxySettings();
        syncResult = syncViaProxyConfig(settings.root, currentConfig.bot || config.bot, currentConfig.proxy || config.proxy);
    }
    return { ok: true, path: configPath, sync: syncResult };
});

ipcMain.handle('get-prompt', async () => {
    const userPrompt = readFileSafe(promptUserPath);
    if (userPrompt && userPrompt.trim().length > 0) {
        return { text: userPrompt, source: 'user', path: promptUserPath };
    }
    const defaultPrompt = readFileSafe(promptDefaultPath) || '';
    return { text: defaultPrompt, source: 'default', path: promptDefaultPath };
});

ipcMain.handle('save-prompt', async (_, text) => {
    writeFileSafe(promptUserPath, String(text || ''));
    return { ok: true, path: promptUserPath };
});

ipcMain.handle('get-default-prompt', async () => {
    const defaultPrompt = readFileSafe(promptDefaultPath) || '';
    return { text: defaultPrompt, source: 'default', path: promptDefaultPath };
});

ipcMain.handle('list-models', async (_, host) => {
    try {
        const models = await listModelsViaApi(host);
        return { models, source: 'api' };
    } catch (e) {
        const cliResult = await listModelsViaCli();
        return { models: cliResult.models || [], source: 'cli', error: cliResult.error || e.message };
    }
});

ipcMain.handle('check-proxy', async (_, host, port) => {
    if (!host || !port) return { ok: false, error: 'host or port missing' };
    return checkTcp(host, port);
});

ipcMain.handle('start-bot', async () => {
    return startBotWithProxy();
});

ipcMain.handle('stop-bot', async () => stopBot());
ipcMain.handle('restart-bot', async () => restartBot());
ipcMain.handle('bot-status', async () => botStatus);
ipcMain.handle('bot-command', async (_, type, payload) => sendBotCommand(type, payload));

ipcMain.handle('start-viaproxy', async () => startViaProxy());
ipcMain.handle('stop-viaproxy', async () => stopViaProxy());
ipcMain.handle('viaproxy-status', async () => ({
    running: Boolean(viaProxyProcess),
    root: getViaProxySettings().root,
    jar: getViaProxySettings().jar
}));
