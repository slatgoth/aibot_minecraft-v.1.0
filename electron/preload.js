const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    loadConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (payload) => ipcRenderer.invoke('save-config', payload),
    loadPrompt: () => ipcRenderer.invoke('get-prompt'),
    loadDefaultPrompt: () => ipcRenderer.invoke('get-default-prompt'),
    savePrompt: (text) => ipcRenderer.invoke('save-prompt', text),
    listModels: (host) => ipcRenderer.invoke('list-models', host),
    checkProxy: (host, port) => ipcRenderer.invoke('check-proxy', host, port),
    startBot: () => ipcRenderer.invoke('start-bot'),
    stopBot: () => ipcRenderer.invoke('stop-bot'),
    restartBot: () => ipcRenderer.invoke('restart-bot'),
    getBotStatus: () => ipcRenderer.invoke('bot-status'),
    botCommand: (type, payload) => ipcRenderer.invoke('bot-command', type, payload),
    startViaProxy: () => ipcRenderer.invoke('start-viaproxy'),
    stopViaProxy: () => ipcRenderer.invoke('stop-viaproxy'),
    getViaProxyStatus: () => ipcRenderer.invoke('viaproxy-status'),
    openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
    onBotStatus: (handler) => ipcRenderer.on('bot-status', (_, status) => handler(status)),
    onBotError: (handler) => ipcRenderer.on('bot-error', (_, payload) => handler(payload)),
    onProxyError: (handler) => ipcRenderer.on('proxy-error', (_, payload) => handler(payload)),
    onBotLog: (handler) => ipcRenderer.on('bot-log', (_, payload) => handler(payload)),
    onProxyLog: (handler) => ipcRenderer.on('proxy-log', (_, payload) => handler(payload))
});
