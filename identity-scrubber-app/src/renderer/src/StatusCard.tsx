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
  if (state.stage === 'idle') {
    return <IdleCard onRetry={onRetry} />;
  }
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col gap-4">
      <StatusText state={state} />
      <StatusProgress state={state} />
      <StatusHint state={state} />
      <StatusActions state={state} onRetry={onRetry} />
    </section>
  );
}

function IdleCard({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm p-8 flex flex-col items-center text-center gap-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight m-0">
          Your documents stay on your device.
        </h2>
        <p className="text-sm text-muted-foreground mt-2 mb-0 max-w-md mx-auto leading-relaxed">
          To make that possible, we need to download the detection files first.
        </p>
      </div>
      <div className="text-xs text-muted-foreground tracking-wide uppercase">
        One-time download · ~850 MB
      </div>
      <button
        onClick={onRetry}
        className="px-6 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors shadow-sm"
      >
        Download &amp; set up
      </button>
    </section>
  );
}

function StatusText({ state }: { state: SetupState }): JSX.Element {
  const isError = state.stage === 'error';
  const text = ((): string => {
    switch (state.stage) {
      case 'checking':
        return 'Getting ready to scrub…';
      case 'idle':
        return '';
      case 'downloading':
        return 'Downloading required files…';
      case 'done':
        return 'Ready to scrub';
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
    state.fileCount && state.fileCount > 1
      ? `Required file (${state.fileIndex}/${state.fileCount})`
      : '';
  const bytesLabel = total ? `${received} / ${total} (${percent}%)` : received;
  const label = sublabel ? `${sublabel} · ${bytesLabel}` : bytesLabel;
  return <ProgressBar percent={percent} label={label} />;
}

function StatusHint({ state }: { state: SetupState }): JSX.Element | null {
  const hint = ((): string | null => {
    switch (state.stage) {
      case 'downloading':
        return 'Cached locally for future launches.';
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
