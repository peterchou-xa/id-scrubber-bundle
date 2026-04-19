import { useEffect, useState } from 'react';

type AppState = 'empty' | 'detected' | 'scrubbed';

interface PIIItem {
  type: string;
  value: string;
  count: number;
  checked: boolean;
}

function formatType(t: string): string {
  return t
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function Icon({ path, className }: { path: string; className?: string }): JSX.Element {
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
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  fileUp: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 18v-6 M9 15l3-3 3 3',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M7 12h10',
  alertTriangle: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  checkCircle: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4 12 14.01l-3-3',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  x: 'M18 6 6 18 M6 6l12 12',
};

export function MainScreen(): JSX.Element {
  const [appState, setAppState] = useState<AppState>('empty');
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [piiItems, setPiiItems] = useState<PIIItem[]>([]);
  const [scrubbedPath, setScrubbedPath] = useState<string>('');

  const handleFileSelect = async (): Promise<void> => {
    const picked = await window.dialogApi.openPdf();
    if (picked) {
      setSelectedFile(picked.name);
      setSelectedFilePath(picked.path);
    }
  };

  useEffect(() => {
    const off = window.scrubber.onEvent((evt) => {
      if (evt.cmd !== 'detect') return;
      if (evt.event === 'pii') {
        const item = evt.item as { type: string; value: string } | undefined;
        if (!item) return;
        setPiiItems((prev) => {
          const existing = prev.find((p) => p.value === item.value && p.type === item.type);
          if (existing) {
            return prev.map((p) =>
              p === existing ? { ...p, count: p.count + 1 } : p,
            );
          }
          return [...prev, { type: item.type, value: item.value, count: 1, checked: true }];
        });
      } else if (evt.event === 'done') {
        const pii = (evt.pii as { type: string; value: string; occurrences: number }[]) ?? [];
        setPiiItems((prev) =>
          pii.map((p) => {
            const prior = prev.find((x) => x.value === p.value && x.type === p.type);
            return {
              type: p.type,
              value: p.value,
              count: p.occurrences,
              checked: prior?.checked ?? true,
            };
          }),
        );
        setIsScanning(false);
        setAppState('detected');
      }
    });
    return off;
  }, []);

  const handleDetect = (): void => {
    if (!selectedFilePath) return;
    setIsScanning(true);
    setPiiItems([]);
    window.scrubber.detect(selectedFilePath).then((res) => {
      if (!res.ok) {
        console.error('detect error:', res.error);
        setIsScanning(false);
      }
    });
  };

  const handleTogglePII = (index: number): void => {
    setPiiItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, checked: !item.checked } : item))
    );
  };

  const handleScrub = async (): Promise<void> => {
    const selected = piiItems.filter((p) => p.checked).map((p) => p.value);
    if (selected.length === 0) return;
    setIsScrubbing(true);
    try {
      const res = await window.scrubber.scrub(selected);
      if (res.ok) {
        const output = (res.result.output as string) ?? '';
        setScrubbedPath(output);
        setAppState('scrubbed');
      } else {
        console.error('scrub error:', res.error);
      }
    } finally {
      setIsScrubbing(false);
    }
  };

  const handleOpenScrubbed = (): void => {
    if (scrubbedPath) window.dialogApi.openPath(scrubbedPath);
  };

  const handleReset = (): void => {
    setAppState('empty');
    setSelectedFile('');
    setSelectedFilePath('');
    setPiiItems([]);
    setIsScanning(false);
    setIsScrubbing(false);
    setScrubbedPath('');
  };

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

      <div className="absolute top-4 right-4 z-50 flex gap-2">
        <button
          onClick={handleReset}
          className="px-3 py-1.5 bg-card text-xs rounded-lg border border-border hover:bg-secondary shadow-sm transition-colors font-medium"
        >
          Empty
        </button>
        <button
          onClick={() => {
            setSelectedFile('confidential_document.pdf');
            setPiiItems([
              { type: 'full_name', value: 'Peter Chou', count: 1, checked: true },
            ]);
            setAppState('detected');
          }}
          className="px-3 py-1.5 bg-card text-xs rounded-lg border border-border hover:bg-secondary shadow-sm transition-colors font-medium"
        >
          Detected
        </button>
        <button
          onClick={() => {
            setSelectedFile('confidential_document.pdf');
            setAppState('scrubbed');
          }}
          className="px-3 py-1.5 bg-card text-xs rounded-lg border border-border hover:bg-secondary shadow-sm transition-colors font-medium"
        >
          Scrubbed
        </button>
      </div>

      <div className="size-full flex flex-col p-8">
        <div className="mb-8 animate-in fade-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-primary/10 border-2 border-primary rounded-lg flex items-center justify-center">
              <Icon path={ICONS.shield} className="w-7 h-7 text-primary" />
            </div>
            <div>
              <h1 className="tracking-tight text-2xl font-semibold">PII Scrubber</h1>
              <p className="text-sm text-muted-foreground">
                Sensitive Data Detection & Removal
              </p>
            </div>
          </div>
          <div className="h-px bg-gradient-to-r from-primary via-primary/30 to-transparent mt-4" />
        </div>

        <div className="flex-1 min-h-0 flex gap-6">
          {/* Left Panel */}
          <div className="w-72 bg-card border border-border rounded-xl shadow-sm p-4 flex flex-col gap-4">
            <div>
              <label className="text-sm mb-3 block text-primary font-medium">
                1. Select PDF File
              </label>
              {!selectedFile ? (
                <button
                  onClick={handleFileSelect}
                  className="w-full px-3 py-5 bg-secondary border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-2 group"
                >
                  <Icon
                    path={ICONS.fileUp}
                    className="w-9 h-9 text-muted-foreground group-hover:text-primary transition-colors"
                  />
                  <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                    Click to choose PDF
                  </span>
                </button>
              ) : (
                <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg flex items-center gap-3">
                  <Icon path={ICONS.file} className="w-6 h-6 text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground font-medium">Selected file</p>
                    <p className="text-sm text-primary truncate" title={selectedFile}>
                      {selectedFile}
                    </p>
                  </div>
                  <button
                    onClick={handleFileSelect}
                    className="text-xs text-primary hover:underline font-medium flex-shrink-0"
                  >
                    Change
                  </button>
                  <button
                    onClick={() => setSelectedFile('')}
                    aria-label="Clear file"
                    className="text-muted-foreground hover:text-foreground flex-shrink-0"
                  >
                    <Icon path={ICONS.x} className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {selectedFile && appState === 'empty' && (
              <div>
                <label className="text-sm mb-3 block text-primary font-medium">2. Detect PII</label>
                <button
                  onClick={handleDetect}
                  disabled={isScanning}
                  className="w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <Icon path={ICONS.scan} className="w-4 h-4" />
                  <span className="font-medium">
                    {isScanning ? 'Scanning...' : 'Analyze Document'}
                  </span>
                </button>
              </div>
            )}

            {appState === 'detected' && (
              <div>
                <label className="text-sm mb-3 block text-primary font-medium">
                  3. Scrub Document
                </label>
                <button
                  onClick={handleScrub}
                  disabled={isScrubbing || piiItems.filter((p) => p.checked).length === 0}
                  className="w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2 relative overflow-hidden group"
                >
                  <Icon path={ICONS.alertTriangle} className="w-4 h-4" />
                  <span className="font-medium">
                    {isScrubbing ? 'Scrubbing...' : 'Execute Scrub'}
                  </span>
                </button>
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  This will create a new sanitized file
                </p>
              </div>
            )}

            {appState === 'scrubbed' && (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-primary/5 border border-primary/20 rounded-xl p-5">
                <Icon path={ICONS.checkCircle} className="w-14 h-14 text-primary" />
                <div className="text-center">
                  <h3 className="mb-2 font-semibold text-lg">Scrub Complete</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    All selected PII has been removed
                  </p>
                  <button
                    onClick={handleOpenScrubbed}
                    className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all flex items-center justify-center gap-2 mx-auto"
                  >
                    <Icon path={ICONS.download} className="w-4 h-4" />
                    <span className="text-sm font-medium">Open File</span>
                  </button>
                  <button
                    onClick={handleReset}
                    className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors underline"
                  >
                    Process another document
                  </button>
                </div>
              </div>
            )}

            <div className="mt-auto pt-4 border-t border-border">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <Icon
                  path={ICONS.alertTriangle}
                  className="w-4 h-4 text-primary mt-0.5 flex-shrink-0"
                />
                <p>
                  This tool removes personally identifiable information from PDF documents. Always
                  review the output before distribution.
                </p>
              </div>
            </div>
          </div>

          {/* Right Panel */}
          <div className="flex-1 min-h-0 bg-card border border-border rounded-xl shadow-sm p-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-lg">Detection Results</h2>
              {(piiItems.length > 0 || isScanning) && (
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                  <span className="text-xs text-muted-foreground font-medium">
                    {isScanning ? 'Scanning' : 'Complete'}
                  </span>
                </div>
              )}
            </div>
            <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mb-6" />

            {piiItems.length === 0 && !isScanning && (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className="w-32 h-32 border-2 border-dashed border-border rounded-xl flex items-center justify-center mb-6 bg-secondary/50">
                  <Icon path={ICONS.scan} className="w-16 h-16 text-muted-foreground/40" />
                </div>
                <p className="text-foreground/70 mb-2 font-medium">No scan results available</p>
                <p className="text-sm text-muted-foreground">
                  Select a PDF file and run detection to begin
                </p>
              </div>
            )}

            {(piiItems.length > 0 || isScanning) && appState !== 'scrubbed' && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
                  {piiItems.map((item, index) => (
                    <div
                      key={`${item.type}:${item.value}`}
                      className="bg-secondary border border-border rounded-lg p-4 hover:border-primary/50 hover:shadow-sm transition-all"
                    >
                      <div className="flex items-start gap-4">
                        <input
                          type="checkbox"
                          checked={item.checked}
                          onChange={() => handleTogglePII(index)}
                          className="mt-1 w-5 h-5 accent-primary cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <span className="text-sm text-primary font-semibold">{formatType(item.type)}</span>
                              <div className="px-2 py-0.5 bg-primary/10 border border-primary/30 rounded">
                                <span className="text-xs text-primary font-medium">
                                  {item.count} occurrence{item.count > 1 ? 's' : ''}
                                </span>
                              </div>
                            </div>
                          </div>
                          <p className="text-foreground/70 break-words">{item.value}</p>
                        </div>
                      </div>
                    </div>
                  ))}

                  {isScanning && (
                    <div className="bg-secondary/50 border border-border border-dashed rounded-lg p-4 flex items-center gap-3">
                      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm text-muted-foreground">
                        Analyzing document for PII...
                      </span>
                    </div>
                  )}
                </div>

                <div className="pt-4 mt-4 border-t border-border">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Total PII types detected: {piiItems.length}</span>
                    <span>
                      Selected for removal: {piiItems.filter((i) => i.checked).length}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {appState === 'scrubbed' && (
              <div className="flex-1 flex flex-col">
                <div className="flex-1 flex flex-col items-center justify-center text-center bg-primary/5 border border-primary/20 rounded-lg p-8">
                  <div className="w-24 h-24 bg-primary/10 border-2 border-primary rounded-xl flex items-center justify-center mb-6">
                    <Icon path={ICONS.shield} className="w-12 h-12 text-primary" />
                  </div>
                  <h3 className="mb-3 text-primary font-semibold text-lg">Document Sanitized</h3>
                  <p className="text-muted-foreground max-w-md mb-6">
                    All selected personally identifiable information has been successfully removed
                    from the document.
                  </p>
                  <div className="bg-secondary border border-border rounded-lg p-4 max-w-md">
                    <p className="text-xs text-muted-foreground mb-2 font-medium">Output file:</p>
                    <button
                      onClick={handleOpenScrubbed}
                      className="text-sm text-primary hover:underline break-all text-left"
                      title={scrubbedPath}
                    >
                      {scrubbedPath ? scrubbedPath.split('/').pop() : ''}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
