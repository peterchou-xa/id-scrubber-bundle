import { ProgressBar } from './ProgressBar';
import type { SetupState } from './useGlinerSetup';

type Props = {
  state: SetupState;
  onRetry: () => void;
};

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StatusCard({ state, onRetry }: Props): JSX.Element {
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col gap-4">
      <StatusText state={state} />
      <StatusProgress state={state} />
      <StatusHint state={state} />
      <StatusActions state={state} onRetry={onRetry} />
    </section>
  );
}

function StatusText({ state }: { state: SetupState }): JSX.Element {
  const isError = state.stage === 'error';
  const text = ((): string => {
    switch (state.stage) {
      case 'checking':
        return 'Checking for PII model…';
      case 'downloading':
        return 'Downloading PII model…';
      case 'done':
        return 'PII model is ready';
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
  if (state.stage !== 'downloading') return null;
  const percent = Math.round((state.percent ?? 0) * 100);
  const received = formatBytes(state.received);
  const total = formatBytes(state.total);
  const sublabel =
    state.fileCount && state.fileCount > 1 && state.file
      ? `${state.file} (${state.fileIndex}/${state.fileCount})`
      : '';
  const bytesLabel = total ? `${received} / ${total} (${percent}%)` : received;
  const label = sublabel ? `${sublabel} · ${bytesLabel}` : bytesLabel;
  return <ProgressBar percent={percent} label={label} />;
}

function StatusHint({ state }: { state: SetupState }): JSX.Element | null {
  const hint = ((): string | null => {
    switch (state.stage) {
      case 'downloading':
        return 'One-time download (~850 MB). Cached locally for future launches.';
      case 'done':
        return state.dir ? `Cached at ${state.dir}` : null;
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
  onRetry,
}: {
  state: SetupState;
  onRetry: () => void;
}): JSX.Element | null {
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
