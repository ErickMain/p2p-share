const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('node:path');
const tailscale = require('./tailscale');
const { createSignalingServer } = require('../signaling/server');

const SIGNAL_PORT = 8787;

// By default Chromium hides local IPs behind generated .local mDNS names, so a
// peer would receive candidates it cannot resolve across the tailnet. Turning
// that off is what lets two tailnet nodes connect directly, with no STUN.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// The renderer picks a source in our own UI, stashes it here, then calls
// getDisplayMedia(); the request handler below answers with that source
// instead of popping Electron's picker on top of ours.
let pendingSourceId = null;
let signaling = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 820,
    height: 1040,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === pendingSourceId) || sources[0];
      if (!source) return callback({});
      // Loopback captures what the machine is playing. Windows only; elsewhere
      // we fall back to no system audio rather than failing the whole request.
      const audio = process.platform === 'win32' ? 'loopback' : undefined;
      callback({ video: source, audio });
    },
    { useSystemPicker: false }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => signaling?.close());

/* ------------------------------------------------------------- capture */

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('sources:select', (_event, id) => {
  pendingSourceId = id;
  return true;
});

/* ----------------------------------------------------------- networking */

ipcMain.handle('net:tailscale', () => tailscale.detect());

/**
 * Starts the embedded signaling server. Bound to all interfaces rather than
 * just the tailnet address so a plain-LAN session still works; reaching it
 * from outside still requires being on the tailnet.
 */
ipcMain.handle('net:serve', async () => {
  const ts = await tailscale.detect();
  if (!signaling) {
    try {
      signaling = createSignalingServer({ host: '0.0.0.0', port: SIGNAL_PORT });
    } catch (err) {
      return { ok: false, reason: err.code === 'EADDRINUSE' ? 'port-busy' : err.message };
    }
  }
  return { ok: true, port: SIGNAL_PORT, ip: ts.ip, hostname: ts.hostname };
});

ipcMain.handle('net:stop-serving', () => {
  signaling?.close();
  signaling = null;
  return true;
});

ipcMain.handle('app:platform', () => process.platform);
