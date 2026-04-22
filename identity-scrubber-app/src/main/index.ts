import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
  isOllamaInstalled,
  installOllama,
  startOllama,
  pingOllama,
  isModelInstalled,
  ensureModel,
  MODEL_NAME,
  USER_OLLAMA_APP,
  ProgressEvent,
} from './ollama';
import { scrubberService, ServeEvent } from './scrubber';

let mainWindow: BrowserWindow | null = null;
let installInFlight = false;

// Custom scheme so the renderer can <img src="idscrub-img:///abs/path/page-1.png">
// without tripping over file:// security restrictions. Must be registered as
// privileged BEFORE app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'idscrub-img',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
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

  // Bridge idscrub-img:// → on-disk PNG. The python scrubber writes pages to
  // a system temp dir and emits absolute paths; the renderer constructs URLs
  // like idscrub-img:///var/folders/.../idscrub-xxx/page-1.png.
  protocol.handle('idscrub-img', (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.handle('ollama:status', async () => {
    const detected = await isOllamaInstalled();
    const running = await pingOllama();
    const modelReady = running ? await isModelInstalled(MODEL_NAME) : false;
    return { ...detected, running, modelReady, model: MODEL_NAME };
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

  const forwardEvent = (evt: ServeEvent): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scrubber:event', evt);
    }
  };

  scrubberService.on('stderr', (chunk: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scrubber:log', chunk);
    }
  });

  ipcMain.handle('scrubber:detect', async (_evt, pdfPath: string) => {
    try {
      const result = await scrubberService.runCommand(
        { cmd: 'detect', path: pdfPath },
        forwardEvent,
      );
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('scrubber:scrub', async (_evt, selected: string[]) => {
    try {
      const result = await scrubberService.runCommand(
        { cmd: 'scrub', selected },
        forwardEvent,
      );
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('shell:openPath', async (_evt, filePath: string) => {
    const err = await shell.openPath(filePath);
    return { ok: err === '', error: err || undefined };
  });

  ipcMain.handle('dialog:openPdf', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select PDF File',
      properties: ['openFile'],
      filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, name: path.basename(filePath) };
  });

  ipcMain.handle('ollama:start', async () => {
    try {
      const res = await startOllama(USER_OLLAMA_APP);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ollama:ensureModel', async () => {
    try {
      if (await isModelInstalled(MODEL_NAME)) return { ok: true, alreadyInstalled: true };
      await ensureModel(MODEL_NAME, emitProgress);
      return { ok: true, alreadyInstalled: false };
    } catch (err) {
      const message = (err as Error).message;
      emitProgress({ stage: 'error', message });
      return { ok: false, error: message };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  scrubberService.shutdown();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scrubberService.shutdown();
});
