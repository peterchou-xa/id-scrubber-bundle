import { contextBridge, ipcRenderer } from 'electron';

export type OllamaStatus = {
  installed: boolean;
  location: string | null;
  running: boolean;
};

export type OllamaInstallResult =
  | { ok: true; location: string; reinstalled: boolean }
  | { ok: false; error: string };

export type OllamaStartResult =
  | { ok: true; alreadyRunning: boolean }
  | { ok: false; error: string };

export type ProgressPayload =
  | { stage: 'downloading'; percent: number; received?: number; total?: number }
  | { stage: 'installing'; step: 'mount' | 'copy' | 'quarantine' }
  | { stage: 'starting'; location?: string }
  | { stage: 'done'; location: string }
  | { stage: 'error'; message: string };

const ollamaApi = {
  getStatus: (): Promise<OllamaStatus> => ipcRenderer.invoke('ollama:status'),
  install: (): Promise<OllamaInstallResult> => ipcRenderer.invoke('ollama:install'),
  start: (): Promise<OllamaStartResult> => ipcRenderer.invoke('ollama:start'),
  onProgress: (callback: (payload: ProgressPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProgressPayload): void =>
      callback(payload);
    ipcRenderer.on('ollama:progress', listener);
    return () => ipcRenderer.removeListener('ollama:progress', listener);
  },
};

export type OllamaApi = typeof ollamaApi;

contextBridge.exposeInMainWorld('ollama', ollamaApi);

export type ServeEvent = Record<string, unknown> & { event: string; cmd?: string };

export type ScrubberCmdResult =
  | { ok: true; result: ServeEvent }
  | { ok: false; error: string };

const scrubberApi = {
  detect: (pdfPath: string): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:detect', pdfPath),
  scrub: (selected: string[]): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:scrub', selected),
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
