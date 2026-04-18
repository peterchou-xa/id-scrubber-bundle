import { useEffect, useRef, useState } from 'react';
import { StatusCard } from './StatusCard';
import { useOllamaSetup } from './useOllamaSetup';

export function App(): JSX.Element {
  const { state, install, retry } = useOllamaSetup();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [result, setResult] = useState<string>('');
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const off = window.scrubber.onLog((chunk) => {
      setLog((prev) => prev + chunk);
    });
    return off;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const handleRun = async (): Promise<void> => {
    setRunning(true);
    setLog('');
    setResult('');
    const res = await window.scrubber.run();
    setRunning(false);
    if (res.ok) {
      setResult(`Exit ${res.code}. Input: ${res.input}\n\n${res.stdout}`);
    } else {
      const err = 'error' in res && res.error ? res.error : `exit ${res.code ?? '?'}`;
      setResult(`Failed (${err}). Input: ${res.input}`);
    }
  };

  return (
    <main className="container">
      <header>
        <h1>Identity Scrubber</h1>
        <p className="subtitle">Setting up AI engine</p>
      </header>
      <StatusCard state={state} onInstall={install} onRetry={retry} />

      <section style={{ marginTop: 16 }}>
        <button onClick={handleRun} disabled={running}>
          {running ? 'Scrubbing…' : 'Run Scrubber (hardcoded test PDF)'}
        </button>
        {log && (
          <pre
            ref={logRef}
            style={{
              marginTop: 12,
              maxHeight: 180,
              overflow: 'auto',
              background: '#111',
              color: '#ddd',
              padding: 8,
              fontSize: 11,
              whiteSpace: 'pre-wrap',
            }}
          >
            {log}
          </pre>
        )}
        {result && (
          <pre
            style={{
              marginTop: 8,
              maxHeight: 220,
              overflow: 'auto',
              background: '#f5f5f5',
              padding: 8,
              fontSize: 11,
              whiteSpace: 'pre-wrap',
            }}
          >
            {result}
          </pre>
        )}
      </section>
    </main>
  );
}
