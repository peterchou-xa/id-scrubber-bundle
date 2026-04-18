import { ProgressBar } from './ProgressBar';
import type { SetupState } from './useOllamaSetup';

type Props = {
  state: SetupState;
  onInstall: () => void;
  onRetry: () => void;
};

const INSTALL_STEP_LABELS: Record<NonNullable<SetupState['step']>, string> = {
  mount: 'Mounting installer…',
  copy: 'Copying Ollama into ~/Applications…',
  quarantine: 'Finalizing installation…',
};

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatusCard({ state, onInstall, onRetry }: Props): JSX.Element {
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col gap-4">
      <StatusText state={state} />
      <StatusProgress state={state} />
      <StatusHint state={state} />
      <StatusActions state={state} onInstall={onInstall} onRetry={onRetry} />
    </section>
  );
}

function StatusText({ state }: { state: SetupState }): JSX.Element {
  const isError = state.stage === 'error';
  const text = ((): string => {
    switch (state.stage) {
      case 'checking':
        return 'Checking for Ollama…';
      case 'idle':
        return 'Ollama is not installed';
      case 'downloading':
        return 'Downloading Ollama…';
      case 'installing':
        return state.step ? INSTALL_STEP_LABELS[state.step] : 'Installing…';
      case 'starting':
        return 'Starting Ollama service…';
      case 'done':
        return 'AI engine is ready';
      case 'error':
        return 'Setup failed';
    }
  })();

  return (
    <div className={`text-base font-medium ${isError ? 'text-primary' : 'text-foreground'}`}>
      {text}
    </div>
  );
}

function StatusProgress({ state }: { state: SetupState }): JSX.Element | null {
  if (state.stage === 'downloading') {
    const percent = Math.round((state.percent ?? 0) * 100);
    const received = formatBytes(state.received);
    const total = formatBytes(state.total);
    const label = total ? `${received} / ${total} (${percent}%)` : received;
    return <ProgressBar percent={percent} label={label} />;
  }
  if (state.stage === 'installing') {
    return <ProgressBar percent={100} label="Please wait" />;
  }
  if (state.stage === 'starting') {
    return <ProgressBar percent={100} label="Almost ready" />;
  }
  return null;
}

function StatusHint({ state }: { state: SetupState }): JSX.Element | null {
  const hint = ((): string | null => {
    switch (state.stage) {
      case 'idle':
        return 'We\u2019ll download it to ~/Applications. No password required.';
      case 'done':
        return state.location ? `Installed at ${state.location}` : null;
      case 'error':
        return state.message ?? 'Something went wrong.';
      default:
        return null;
    }
  })();

  if (!hint) return null;
  return <p className="text-xs text-muted-foreground m-0">{hint}</p>;
}

function StatusActions({
  state,
  onInstall,
  onRetry,
}: {
  state: SetupState;
  onInstall: () => void;
  onRetry: () => void;
}): JSX.Element | null {
  if (state.stage === 'idle') {
    return (
      <div className="flex justify-end gap-3">
        <button
          onClick={onInstall}
          className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors"
        >
          Install
        </button>
      </div>
    );
  }
  if (state.stage === 'error') {
    return (
      <div className="flex justify-end gap-3">
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-sm font-medium rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }
  return null;
}
