import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProgressPayload } from '../../preload/index';

export type SetupStage =
  | 'checking'
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'done'
  | 'error';

export type SetupState = {
  stage: SetupStage;
  percent?: number;
  received?: number;
  total?: number;
  step?: 'mount' | 'copy' | 'quarantine';
  location?: string;
  message?: string;
};

export type OllamaSetup = {
  state: SetupState;
  install: () => Promise<void>;
  retry: () => Promise<void>;
};

export function useOllamaSetup(): OllamaSetup {
  const [state, setState] = useState<SetupState>({ stage: 'checking' });
  const installingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    setState({ stage: 'checking' });
    try {
      const status = await window.ollama.getStatus();
      if (status.installed && status.running) {
        setState({ stage: 'done', location: status.location ?? undefined });
      } else if (status.installed && !status.running) {
        setState({ stage: 'starting' });
        const res = await window.ollama.start();
        if (res.ok) {
          setState({ stage: 'done', location: status.location ?? undefined });
        } else {
          setState({ stage: 'error', message: res.error });
        }
      } else {
        setState({ stage: 'idle' });
      }
    } catch (err) {
      setState({ stage: 'error', message: (err as Error).message });
    }
  }, []);

  const install = useCallback(async () => {
    if (installingRef.current) return;
    installingRef.current = true;
    setState({ stage: 'downloading', percent: 0 });
    try {
      const result = await window.ollama.install();
      if (!result.ok) {
        setState({ stage: 'error', message: result.error });
      }
      // done/progress states are driven by onProgress events
    } finally {
      installingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = window.ollama.onProgress((payload: ProgressPayload) => {
      setState((prev) => {
        switch (payload.stage) {
          case 'downloading':
            return {
              stage: 'downloading',
              percent: payload.percent,
              received: payload.received,
              total: payload.total,
            };
          case 'installing':
            return { stage: 'installing', step: payload.step };
          case 'starting':
            return { stage: 'starting', location: payload.location };
          case 'done':
            return { stage: 'done', location: payload.location };
          case 'error':
            return { stage: 'error', message: payload.message };
          default:
            return prev;
        }
      });
    });

    refreshStatus();
    return unsubscribe;
  }, [refreshStatus]);

  return { state, install, retry: refreshStatus };
}
