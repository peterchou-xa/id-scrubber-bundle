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

export type ServeEvent = Record<string, unknown> & {
  cmd?: string;
  phase?: string;
  status?: string;
  kind?: string;
};

export type ScrubberCmdResult =
  | { ok: true; result: ServeEvent }
  | { ok: false; error: string };

export type CustomPiiInput = { value: string; type?: string };

const scrubberApi = {
  detect: (
    pdfPath: string,
    customPii?: Array<CustomPiiInput | string>,
  ): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:detect', pdfPath, customPii),
  scrub: (
    selected: string[],
    color?: string,
    byType?: Record<string, number>,
  ): Promise<ScrubberCmdResult> =>
    ipcRenderer.invoke('scrubber:scrub', selected, color, byType),
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

export type IdentifierType = 'name' | 'ssn' | 'dob' | 'email' | 'address' | 'other';

export interface Identifier {
  type: IdentifierType;
  value: string;
}

export type IdentifiersLoadResult =
  | { ok: true; values: Identifier[] }
  | { ok: false; error: string };

export type IdentifiersSaveResult = { ok: true } | { ok: false; error: string };

const identifiersApi = {
  load: (): Promise<IdentifiersLoadResult> => ipcRenderer.invoke('identifiers:load'),
  save: (values: Identifier[]): Promise<IdentifiersSaveResult> =>
    ipcRenderer.invoke('identifiers:save', values),
};

export type IdentifiersApi = typeof identifiersApi;

contextBridge.exposeInMainWorld('identifiers', identifiersApi);

export interface BalanceView {
  usage: number;
  granted: number;
  resets_at?: string;
  expires_at?: string;
}

export interface ConsumeResponse {
  allow: boolean;
  reason?: 'invalid_device' | 'insufficient_balance' | 'network_error';
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  error?: string;
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device' | 'network_error';
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  error?: string;
}

const billingApi = {
  consume: (pages: number): Promise<ConsumeResponse> =>
    ipcRenderer.invoke('billing:consume', pages),
  balance: (): Promise<BalanceResponse> => ipcRenderer.invoke('billing:balance'),
};

export type BillingApi = typeof billingApi;

contextBridge.exposeInMainWorld('billing', billingApi);
