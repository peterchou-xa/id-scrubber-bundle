import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import {
  ensureGlinerModel,
  getGlinerStatus,
  GlinerProgress,
  GlinerStatus,
} from './gliner';
import { scrubberService, ServeEvent } from './scrubber';
import { loadIdentifiers, saveIdentifiers } from './identifiersStore';
import { recordScrubEvent } from './metrics';
import {
  consumePages,
  fetchBalance,
  redeemLicenseKey,
  startCheckout,
  type Tier,
} from './billing';

let mainWindow: BrowserWindow | null = null;
let downloadInFlight = false;

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

function emitGlinerProgress(payload: GlinerProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gliner:progress', payload);
  }
}

async function startGlinerDownload(): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (downloadInFlight) {
    return { ok: false, error: 'Download already in progress' };
  }
  downloadInFlight = true;
  try {
    const dir = await ensureGlinerModel(emitGlinerProgress);
    return { ok: true, dir };
  } catch (err) {
    const message = (err as Error).message;
    emitGlinerProgress({ stage: 'error', message });
    return { ok: false, error: message };
  } finally {
    downloadInFlight = false;
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

  ipcMain.handle('gliner:status', async (): Promise<GlinerStatus> => {
    return getGlinerStatus();
  });

  ipcMain.handle('gliner:download', async () => {
    return startGlinerDownload();
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

  ipcMain.handle(
    'scrubber:detect',
    async (
      _evt,
      pdfPath: string,
      customPii?: Array<{ value: string; type?: string } | string>,
    ) => {
    try {
      const req: Record<string, unknown> = { cmd: 'detect', path: pdfPath };
      const cleaned = (customPii ?? [])
        .map((entry) => {
          if (typeof entry === 'string') {
            const v = entry.trim();
            return v ? { value: v, type: 'other' } : null;
          }
          if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
            const v = entry.value.trim();
            if (!v) return null;
            const t = typeof entry.type === 'string' ? entry.type.trim() : '';
            return { value: v, type: t || 'other' };
          }
          return null;
        })
        .filter((v): v is { value: string; type: string } => v !== null);
      if (cleaned.length > 0) {
        req.options = { custom_pii: cleaned };
      }
      const result = await scrubberService.runCommand(req, forwardEvent);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'scrubber:scrub',
    async (
      _evt,
      selected: string[],
      color?: string,
      byType?: Record<string, number>,
    ) => {
      try {
        const req: Record<string, unknown> = { cmd: 'scrub', selected };
        if (color) req.color = color;
        const result = await scrubberService.runCommand(req, forwardEvent);
        if (byType && Object.keys(byType).length > 0) {
          void recordScrubEvent({ count: selected.length, byType });
        }
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('billing:consume', async (_evt, pages: number) => {
    return consumePages(Number(pages));
  });

  ipcMain.handle('billing:balance', async (_evt, opts?: { includeLicenses?: boolean }) => {
    return fetchBalance(opts);
  });

  ipcMain.handle('billing:startCheckout', async (_evt, tier: Tier) => {
    return startCheckout(tier);
  });

  ipcMain.handle('billing:redeemLicenseKey', async (_evt, key: string) => {
    return redeemLicenseKey(key);
  });

  ipcMain.handle('shell:openPath', async (_evt, filePath: string) => {
    const err = await shell.openPath(filePath);
    return { ok: err === '', error: err || undefined };
  });

  ipcMain.handle('identifiers:load', async () => {
    try {
      const values = await loadIdentifiers();
      return { ok: true, values };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('identifiers:save', async (_evt, values: string[]) => {
    try {
      await saveIdentifiers(values);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS, closing the last window keeps the app alive in the dock —
  // don't tear down the python serve loop, since reopening the window
  // would force a multi-second ONNX/PaddleOCR cold start. Other platforms
  // quit the app, which fires before-quit and shuts the scrubber down there.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scrubberService.shutdown();
});
