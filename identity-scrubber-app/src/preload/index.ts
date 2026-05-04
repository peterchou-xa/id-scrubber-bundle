import { contextBridge, ipcRenderer } from 'electron';

export type GlinerStatus = {
  cached: boolean;
  dir: string;
  repo: string;
};

export type GlinerDownloadResult =
  | { ok: true; dir: string }
  | { ok: false; error: string };

export type GlinerProgress =
  | { stage: 'checking' }
  | { stage: 'cached' }
  | { stage: 'starting'; totalBytes?: number }
  | {
      stage: 'downloading';
      file: string;
      fileIndex: number;
      fileCount: number;
      received: number;
      total: number;
      overallReceived: number;
      overallTotal: number;
      percent: number;
    }
  | { stage: 'done'; dir: string }
  | { stage: 'error'; message: string };

const glinerApi = {
  getStatus: (): Promise<GlinerStatus> => ipcRenderer.invoke('gliner:status'),
  download: (): Promise<GlinerDownloadResult> => ipcRenderer.invoke('gliner:download'),
  onProgress: (callback: (payload: GlinerProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: GlinerProgress): void =>
      callback(payload);
    ipcRenderer.on('gliner:progress', listener);
    return () => ipcRenderer.removeListener('gliner:progress', listener);
  },
};

export type GlinerApi = typeof glinerApi;

contextBridge.exposeInMainWorld('gliner', glinerApi);

export type ServeEvent = Record<string, unknown> & { event: string; cmd?: string };

export type ScrubberCmdResult =
  | { ok: true; result: ServeEvent }
  | { ok: false; error: string };

const scrubberApi = {
  detect: (pdfPath: string): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:detect', pdfPath),
  scrub: (selected: string[], color?: string): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:scrub', selected, color),
  onEvent: (callback: (evt: ServeEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, evt: ServeEvent): void => callback(evt);
    ipcRenderer.on('scrubber:event', listener);
    return () => ipcRenderer.removeListener('scrubber:event', listener);
  },
  onLog: (callback: (chunk: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: string): void => callback(chunk);
    ipcRenderer.on('scrubber:log', listener);
    return () => ipcRenderer.removeListener('scrubber:log', listener);
  },
};

export type ScrubberApi = typeof scrubberApi;

contextBridge.exposeInMainWorld('scrubber', scrubberApi);

export type PickedPdf = { path: string; name: string } | null;

const dialogApi = {
  openPdf: (): Promise<PickedPdf> => ipcRenderer.invoke('dialog:openPdf'),
  openPath: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openPath', filePath),
};

export type DialogApi = typeof dialogApi;

contextBridge.exposeInMainWorld('dialogApi', dialogApi);
