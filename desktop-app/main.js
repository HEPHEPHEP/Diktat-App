const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
let config = { serverUrl: '', token: '' };

function loadConfig() { try { if (fs.existsSync(CONFIG_FILE)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {} }
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {} }

let mainWindow = null, textWindow = null, tray = null;

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 420, height: 580, minWidth: 380, minHeight: 500, frame: false, resizable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }, show: false
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', e => { if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); } });
}

function createTextWindow() {
    textWindow = new BrowserWindow({
        width: 480, height: 180, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }, show: false
    });
    textWindow.loadFile(path.join(__dirname, 'renderer', 'text-window.html'));
}

function createTray() {
    try { tray = new Tray(path.join(__dirname, 'icon.png')); } catch { return; }
    tray.setToolTip('Dictation');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Öffnen', click: () => mainWindow.show() },
        { label: 'Text-Fenster', type: 'checkbox', checked: false, click: m => m.checked ? textWindow.show() : textWindow.hide() },
        { type: 'separator' },
        { label: 'Beenden', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', () => mainWindow.show());
}

ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (e, c) => { config = { ...config, ...c }; saveConfig(); return true; });
ipcMain.handle('logout', () => { config.token = ''; saveConfig(); return true; });
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('close-window', () => mainWindow.hide());
ipcMain.on('insert-text', (e, text) => {
    const saved = clipboard.readText();
    clipboard.writeText(text);
    const { keyboard, Key } = require('@nut-tree/nut-js');
    const mod = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    keyboard.pressKey(mod); keyboard.pressKey(Key.V); keyboard.releaseKey(Key.V); keyboard.releaseKey(mod);
    setTimeout(() => clipboard.writeText(saved), 100);
});
ipcMain.on('execute-command', (e, cmd) => {
    const { keyboard, Key } = require('@nut-tree/nut-js');
    const k = { enter: Key.Return, space: Key.Space, backspace: Key.Backspace, tab: Key.Tab }[cmd];
    if (k) { keyboard.pressKey(k); keyboard.releaseKey(k); }
});
ipcMain.on('update-text-window', (e, t) => { if (textWindow) textWindow.webContents.send('update-text', t); });
ipcMain.on('show-text-window', () => { if (textWindow) textWindow.show(); });
ipcMain.on('hide-text-window', () => { if (textWindow) textWindow.hide(); });

app.whenReady().then(() => {
    loadConfig();
    createMainWindow();
    createTextWindow();
    createTray();
    globalShortcut.register('CommandOrControl+Shift+D', () => mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()));
    globalShortcut.register('CommandOrControl+Shift+T', () => textWindow.isVisible() ? textWindow.hide() : textWindow.show());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); else mainWindow.show(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => app.isQuitting = true);
