import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
  isOllamaInstalled,
  installOllama,
  startOllama,
  pingOllama,
  USER_OLLAMA_APP,
  ProgressEvent,
} from './ollama';
import { runScrubber, defaultTestPdf } from './scrubber';

let mainWindow: BrowserWindow | null = null;
let installInFlight = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    show: false,
    title: 'Identity Scrubber',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function emitProgress(payload: ProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ollama:progress', payload);
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.identityscrubber.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.handle('ollama:status', async () => {
    const detected = await isOllamaInstalled();
    const running = await pingOllama();
    return { ...detected, running };
  });

  ipcMain.handle('ollama:install', async () => {
    if (installInFlight) {
      return { ok: false, error: 'Install already in progress' };
    }
    installInFlight = true;
    try {
      const result = await installOllama({ onEvent: emitProgress });
      return { ok: true, ...result };
    } catch (err) {
      const message = (err as Error).message;
      emitProgress({ stage: 'error', message });
      return { ok: false, error: message };
    } finally {
      installInFlight = false;
    }
  });

  ipcMain.handle('scrubber:run', async (_evt, pdfPath?: string) => {
    const input = pdfPath && pdfPath.length > 0 ? pdfPath : defaultTestPdf();
    try {
      const result = await runScrubber(input, (chunk) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scrubber:log', chunk);
        }
      });
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, input };
    } catch (err) {
      return { ok: false, error: (err as Error).message, input };
    }
  });

  ipcMain.handle('ollama:start', async () => {
    try {
      const res = await startOllama(USER_OLLAMA_APP);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
