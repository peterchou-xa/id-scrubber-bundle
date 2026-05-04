import { MainScreen } from './MainScreen';
import { StatusCard } from './StatusCard';
import { useGlinerSetup } from './useGlinerSetup';

function ShieldIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function App(): JSX.Element {
  const { state, retry } = useGlinerSetup();

  if (state.stage === 'done') {
    return <MainScreen />;
  }

  return (
    <div className="size-full bg-background overflow-hidden relative">
      <div
        className="absolute inset-0 pointer-events-none z-0 opacity-[0.02]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #DC2626 1px, transparent 1px), linear-gradient(to bottom, #DC2626 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />
      <main className="relative z-10 max-w-xl mx-auto p-8 flex flex-col gap-6">
        <header>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-primary/10 border-2 border-primary rounded-lg flex items-center justify-center">
              <ShieldIcon className="w-7 h-7 text-primary" />
            </div>
            <div>
              <h1 className="tracking-tight text-2xl font-semibold m-0">PII Scrubber</h1>
              <p className="text-sm text-muted-foreground m-0">Setting up AI engine</p>
            </div>
          </div>
          <div className="h-px bg-gradient-to-r from-primary via-primary/30 to-transparent mt-4" />
        </header>
        <StatusCard state={state} onRetry={retry} />
      </main>
    </div>
  );
}
