import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlinerProgress } from '../../preload/index';

export type SetupStage = 'checking' | 'idle' | 'downloading' | 'done' | 'error';

export type SetupState = {
  stage: SetupStage;
  percent?: number;
  received?: number;
  total?: number;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
  message?: string;
  dir?: string;
};

export type GlinerSetup = {
  state: SetupState;
  retry: () => Promise<void>;
};

export function useGlinerSetup(): GlinerSetup {
  const [state, setState] = useState<SetupState>({ stage: 'checking' });
  const downloadingRef = useRef(false);

  const checkStatus = useCallback(async () => {
    try {
      const status = await window.gliner.getStatus();
      setState((prev) => {
        if (status.cached) return { stage: 'done', dir: status.dir };
        // Not cached: surface an idle state so the UI can show a download
        // button. Don't clobber an in-flight 'downloading' if progress events
        // already arrived first.
        if (prev.stage === 'downloading') return prev;
        return { stage: 'idle' };
      });
    } catch (err) {
      setState({ stage: 'error', message: (err as Error).message });
    }
  }, []);

  const retry = useCallback(async () => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setState({ stage: 'checking' });
    try {
      const result = await window.gliner.download();
      if (!result.ok) {
        setState({ stage: 'error', message: result.error });
      }
    } finally {
      downloadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.gliner.onProgress((payload: GlinerProgress) => {
      setState((prev) => {
        switch (payload.stage) {
          case 'checking':
            return { stage: 'checking' };
          case 'cached':
            // 'done' will follow immediately; keep prev so we don't flicker.
            return prev;
          case 'starting':
            return {
              stage: 'downloading',
              percent: 0,
              total: payload.totalBytes,
            };
          case 'downloading':
            return {
              stage: 'downloading',
              percent: payload.percent,
              received: payload.overallReceived,
              total: payload.overallTotal,
              file: payload.file,
              fileIndex: payload.fileIndex,
              fileCount: payload.fileCount,
            };
          case 'done':
            return { stage: 'done', dir: payload.dir };
          case 'error':
            return { stage: 'error', message: payload.message };
          default:
            return prev;
        }
      });
    });

    checkStatus();
    return unsubscribe;
  }, [checkStatus]);

  return { state, retry };
}
