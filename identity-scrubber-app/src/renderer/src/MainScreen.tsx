import { useEffect, useMemo, useState } from 'react';

type AppState = 'empty' | 'detected' | 'scrubbed';

interface PiiBBox {
  page_num: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PageInfo {
  image_path: string;
  image_width: number;
  image_height: number;
}

interface PIIItem {
  type: string;
  value: string;
  count: number;
  checked: boolean;
  bboxes: PiiBBox[];
}

type DetectStatus =
  | { phase: 'ocr' }
  | { phase: 'analyze'; chunk: number; total: number };

function statusText(s: DetectStatus | null): string {
  if (!s) return 'Analyzing document for PII…';
  if (s.phase === 'ocr') return 'Reading text from the PDF…';
  const pct = s.total > 0 ? Math.round((s.chunk / s.total) * 100) : 0;
  return `Detecting PII (${pct}%)…`;
}

function imgUrl(absPath: string): string {
  // Fixed dummy host "local" so the URL parser doesn't consume the first
  // path segment as the authority (which would drop the leading '/var/').
  // Each segment is URL-encoded for spaces/special chars.
  return 'idscrub-img://local' + absPath.split('/').map(encodeURIComponent).join('/');
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
  edit: 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  refresh: 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M20.49 15a9 9 0 0 1-14.85 3.36L1 14',
};

const HIGHLIGHT_COLORS = {
  red: { base: '#DC2626', label: 'Red' },
  yellow: { base: '#EAB308', label: 'Yellow' },
  green: { base: '#16A34A', label: 'Green' },
  blue: { base: '#2563EB', label: 'Blue' },
  black: { base: '#000000', label: 'Black' },
} as const;
type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

export function MainScreen(): JSX.Element {
  const [appState, setAppState] = useState<AppState>('empty');
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [piiItems, setPiiItems] = useState<PIIItem[]>([]);
  const [scrubbedPath, setScrubbedPath] = useState<string>('');
  const [pages, setPages] = useState<Map<number, PageInfo>>(new Map());
  const [hoveredValue, setHoveredValue] = useState<string | null>(null);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('red');
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [detectStatus, setDetectStatus] = useState<DetectStatus | null>(null);

  const handleFileSelect = async (): Promise<void> => {
    const picked = await window.dialogApi.openPdf();
    if (picked) {
      handleReset();
      setSelectedFile(picked.name);
      setSelectedFilePath(picked.path);
    }
  };

  useEffect(() => {
    const off = window.scrubber.onEvent((evt) => {
      console.log('[scrubber event]', evt);
      if (evt.cmd !== 'detect') return;
      if (evt.kind === 'page') {
        const pageNum = evt.page_num as number | undefined;
        const imagePath = evt.image_path as string | undefined;
        const imgW = evt.image_width as number | undefined;
        const imgH = evt.image_height as number | undefined;
        if (!pageNum || !imagePath || !imgW || !imgH) return;
        setPages((prev) => {
          const next = new Map(prev);
          next.set(pageNum, { image_path: imagePath, image_width: imgW, image_height: imgH });
          return next;
        });
      } else if (evt.kind === 'pii') {
        const item = evt.item as { type: string; value: string } | undefined;
        if (!item) return;
        setPiiItems((prev) => {
          const existing = prev.find((p) => p.value === item.value && p.type === item.type);
          if (existing) {
            return prev.map((p) =>
              p === existing ? { ...p, count: p.count + 1 } : p,
            );
          }
          return [...prev, { type: item.type, value: item.value, count: 1, checked: true, bboxes: [] }];
        });
      } else if (evt.phase === 'ocr' && evt.status === 'started') {
        setDetectStatus({ phase: 'ocr' });
      } else if (evt.phase === 'analyze' && evt.status === 'in_progress') {
        const chunk = evt.chunk as number | undefined;
        const total = evt.total as number | undefined;
        if (typeof chunk === 'number' && typeof total === 'number') {
          setDetectStatus({ phase: 'analyze', chunk, total });
        }
      } else if (evt.phase === 'analyze' && evt.status === 'done') {
        const pii =
          (evt.pii as {
            type: string;
            value: string;
            occurrences: number;
            bboxes?: PiiBBox[];
          }[]) ?? [];
        setPiiItems((prev) =>
          pii.map((p) => {
            const prior = prev.find((x) => x.value === p.value && x.type === p.type);
            return {
              type: p.type,
              value: p.value,
              count: p.occurrences,
              checked: prior?.checked ?? true,
              bboxes: p.bboxes ?? [],
            };
          }),
        );
        setIsScanning(false);
        setDetectStatus(null);
        setAppState('detected');
      }
    });
    return off;
  }, []);

  const handleDetect = (): void => {
    if (!selectedFilePath) return;
    setIsScanning(true);
    setDetectStatus(null);
    setPiiItems([]);
    setPages(new Map());
    setHoveredValue(null);
    window.scrubber.detect(selectedFilePath).then((res) => {
      if (!res.ok) {
        console.error('detect error:', res.error);
        setIsScanning(false);
        setDetectStatus(null);
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
      const res = await window.scrubber.scrub(selected, HIGHLIGHT_COLORS[highlightColor].base);
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
    setPages(new Map());
    setHoveredValue(null);
  };

  // Show all checked PII bboxes on the current preview page as translucent
  // highlights. Hovering a PII entry jumps to its page (if different) and
  // emphasizes its boxes.
  const previewPanel = useMemo(() => {
    const hovered = hoveredValue
      ? piiItems.find((p) => p.value === hoveredValue)
      : null;
    const hoveredPage = hovered?.bboxes[0]?.page_num;
    const pageNum = hoveredPage ?? (pages.size > 0 ? Math.min(...pages.keys()) : null);
    if (pageNum == null) return null;
    const page = pages.get(pageNum);
    if (!page) return null;
    const overlays = piiItems.flatMap((p) =>
      p.checked
        ? p.bboxes
            .filter((b) => b.page_num === pageNum)
            .map((b) => ({ bbox: b, value: p.value, isHovered: p.value === hoveredValue }))
        : [],
    );
    return { page, pageNum, overlays };
  }, [hoveredValue, piiItems, pages]);

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


      {/*
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
              { type: 'name', value: 'Peter Chou', count: 1, checked: true },
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
      */}

      <div className="size-full flex flex-col p-6">
        <div className="mb-4 flex items-center gap-2">
          <div className="w-7 h-7 bg-primary/10 border border-primary rounded-md flex items-center justify-center">
            <Icon path={ICONS.shield} className="w-4 h-4 text-primary" />
          </div>
          <h1 className="tracking-tight text-base font-semibold">PII Scrubber</h1>
        </div>

        <div className="flex-1 min-h-0 flex gap-6">
          {/* Left column: file controls + detection results */}
          <div className="w-[420px] flex-shrink-0 bg-card border border-border rounded-xl shadow-sm p-5 flex flex-col">
            {/* File picker */}
            {!selectedFile ? (
              <button
                onClick={handleFileSelect}
                className="w-full px-3 py-4 bg-secondary border-2 border-dashed border-border rounded-lg hover:border-primary hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-2 group"
              >
                <Icon
                  path={ICONS.fileUp}
                  className="w-7 h-7 text-muted-foreground group-hover:text-primary transition-colors"
                />
                <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                  Click to browse for a PDF
                </span>
              </button>
            ) : (
              <div className="p-2.5 bg-primary/5 border border-primary/20 rounded-lg flex items-center gap-2">
                <Icon path={ICONS.file} className="w-5 h-5 text-primary flex-shrink-0" />
                <button
                  onClick={() => {
                    if (selectedFilePath) window.dialogApi.openPath(selectedFilePath);
                  }}
                  className="flex-1 min-w-0 text-sm text-primary hover:underline truncate text-left cursor-pointer"
                  title={selectedFile}
                >
                  {selectedFile}
                </button>
                <button
                  onClick={handleFileSelect}
                  aria-label="Change file"
                  title="Change file"
                  className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors cursor-pointer flex-shrink-0"
                >
                  <Icon path={ICONS.edit} className="w-4 h-4" />
                </button>
                <button
                  onClick={handleReset}
                  aria-label="Clear file"
                  title="Clear file"
                  className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors cursor-pointer flex-shrink-0"
                >
                  <Icon path={ICONS.x} className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Primary action button */}
            {selectedFile && appState === 'empty' && (
              <button
                onClick={handleDetect}
                disabled={isScanning}
                className="mt-3 w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Icon path={ICONS.scan} className="w-4 h-4" />
                <span className="font-medium">
                  {isScanning ? 'Scanning...' : 'Run Detection'}
                </span>
              </button>
            )}

            {appState === 'detected' && (
              <button
                onClick={handleScrub}
                disabled={isScrubbing || piiItems.filter((p) => p.checked).length === 0}
                className="mt-3 w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Icon path={ICONS.alertTriangle} className="w-4 h-4" />
                <span className="font-medium">
                  {isScrubbing ? 'Scrubbing...' : 'Execute Scrub'}
                </span>
              </button>
            )}

            {appState === 'scrubbed' && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex items-center gap-3">
                  <Icon path={ICONS.checkCircle} className="w-6 h-6 text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Scrub complete</p>
                    <button
                      onClick={handleOpenScrubbed}
                      className="text-xs text-primary hover:underline truncate block w-full text-left cursor-pointer"
                      title={scrubbedPath}
                    >
                      {scrubbedPath ? scrubbedPath.split('/').pop() : ''}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleReset}
                  className="w-full px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all flex items-center justify-center gap-2"
                >
                  <Icon path={ICONS.refresh} className="w-4 h-4" />
                  <span className="text-sm font-medium">Start Over</span>
                </button>
              </div>
            )}

            <div className="h-px bg-border my-4" />

            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-base">Detection Results</h2>
            </div>

            {piiItems.length === 0 && !isScanning && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                <Icon path={ICONS.scan} className="w-12 h-12 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {selectedFile ? 'Run detection to begin' : 'Select a PDF file to begin'}
                </p>
              </div>
            )}

            {(piiItems.length > 0 || isScanning) && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
                  {(() => {
                    const groups = new Map<string, { type: string; entries: { item: PIIItem; index: number }[] }>();
                    piiItems.forEach((item, index) => {
                      const g = groups.get(item.type) ?? { type: item.type, entries: [] };
                      g.entries.push({ item, index });
                      groups.set(item.type, g);
                    });
                    const sortedGroups = Array.from(groups.values())
                      .map((g) => ({
                        ...g,
                        totalCount: g.entries.reduce((sum, e) => sum + e.item.count, 0),
                        entries: [...g.entries].sort((a, b) => b.item.count - a.item.count),
                      }))
                      .sort((a, b) => b.totalCount - a.totalCount);
                    return sortedGroups.map((group) => {
                      const totalCount = group.totalCount;
                      return (
                        <div
                          key={group.type}
                          className="bg-secondary border border-border rounded-lg p-4 hover:border-primary/50 hover:shadow-sm transition-all"
                        >
                          <div className="flex items-center justify-between mb-3">
                            <span className="text-sm text-primary font-semibold">{formatType(group.type)}</span>
                            <div className="px-2 py-0.5 bg-primary/10 border border-primary/30 rounded flex-shrink-0">
                              <span className="text-xs text-primary font-medium">
                                {totalCount} occurrence{totalCount > 1 ? 's' : ''}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            {group.entries.map(({ item, index }) => {
                              const isScrubbed = appState === 'scrubbed' && item.checked;
                              const isHovered = hoveredValue === item.value;
                              return (
                                <div
                                  key={`${item.type}:${item.value}`}
                                  className={`flex items-start gap-3 -mx-1 px-1 py-0.5 rounded ${
                                    isHovered ? 'bg-primary/10' : ''
                                  }`}
                                  onMouseEnter={() => setHoveredValue(item.value)}
                                  onMouseLeave={() =>
                                    setHoveredValue((v) => (v === item.value ? null : v))
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={item.checked}
                                    onChange={() => handleTogglePII(index)}
                                    disabled={appState === 'scrubbed'}
                                    className="mt-0.5 w-5 h-5 accent-primary cursor-pointer disabled:cursor-not-allowed flex-shrink-0"
                                  />
                                  <p className={`flex-1 min-w-0 text-foreground/70 break-words ${isScrubbed ? 'line-through opacity-60' : ''}`}>
                                    {item.value}
                                  </p>
                                  {group.entries.length > 1 && (
                                    <span className="text-xs text-muted-foreground flex-shrink-0 mt-0.5">
                                      ×{item.count}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}

                  {isScanning && (
                    <div className="bg-secondary/50 border border-border border-dashed rounded-lg p-4 flex items-center gap-3">
                      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm text-muted-foreground">
                        {statusText(detectStatus)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="pt-4 mt-4 border-t border-border">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Total PII types detected: {piiItems.length}</span>
                    <span>
                      {appState === 'scrubbed' ? 'Removed' : 'Selected for removal'}: {piiItems.filter((i) => i.checked).length}
                    </span>
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* Right column: PDF preview with bbox overlays */}
          <div className="flex-1 min-w-0 min-h-0 bg-card border border-border rounded-xl shadow-sm p-5 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-base">Preview</h2>
                <div className="relative">
                  <button
                    onClick={() => setColorPickerOpen((v) => !v)}
                    onBlur={() => setTimeout(() => setColorPickerOpen(false), 150)}
                    aria-label="Highlight color"
                    title="Highlight color"
                    className="w-6 h-6 rounded-md border border-border hover:border-foreground/40 transition-colors flex items-center justify-center"
                  >
                    <span
                      className="w-4 h-4 rounded-sm border"
                      style={{
                        backgroundColor: HIGHLIGHT_COLORS[highlightColor].base + '66',
                        borderColor: HIGHLIGHT_COLORS[highlightColor].base,
                      }}
                    />
                  </button>
                  {colorPickerOpen && (
                    <div className="absolute left-0 top-full mt-1 z-10 bg-card border border-border rounded-lg shadow-md p-2 flex gap-1.5">
                      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((key) => {
                        const c = HIGHLIGHT_COLORS[key];
                        const selected = key === highlightColor;
                        return (
                          <button
                            key={key}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setHighlightColor(key);
                              setColorPickerOpen(false);
                            }}
                            aria-label={c.label}
                            title={c.label}
                            className={`w-6 h-6 rounded-md border-2 transition-transform hover:scale-110 ${
                              selected ? '' : 'border-transparent'
                            }`}
                            style={{
                              backgroundColor: c.base + '66',
                              borderColor: selected ? c.base : 'transparent',
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              {previewPanel && (
                <span className="text-xs text-muted-foreground">
                  Page {previewPanel.pageNum} / {pages.size}
                  {hoveredValue
                    ? ` · ${previewPanel.overlays.filter((o) => o.isHovered).length} match(es)`
                    : ` · ${previewPanel.overlays.length} highlight(s)`}
                </span>
              )}
            </div>

            <div className="flex-1 min-h-0 flex items-center justify-center">
              {!previewPanel && (
                <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  <Icon path={ICONS.file} className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p>Run detection to preview pages.</p>
                  <p className="mt-1">Hover a PII entry to highlight its location.</p>
                </div>
              )}
              {previewPanel && (
                <div
                  className="relative bg-secondary border border-border rounded h-full max-w-full"
                  style={{
                    aspectRatio: `${previewPanel.page.image_width} / ${previewPanel.page.image_height}`,
                  }}
                >
                  <img
                    src={imgUrl(previewPanel.page.image_path)}
                    alt={`Page ${previewPanel.pageNum}`}
                    className="absolute inset-0 w-full h-full object-contain select-none"
                    draggable={false}
                  />
                  {previewPanel.overlays.map((o, i) => {
                    const base = HIGHLIGHT_COLORS[highlightColor].base;
                    const anyHover = hoveredValue != null;
                    const dimmed = anyHover && !o.isHovered;
                    return (
                      <div
                        key={i}
                        className="absolute rounded-sm pointer-events-none transition-all"
                        style={{
                          left: `${(o.bbox.x / previewPanel.page.image_width) * 100}%`,
                          top: `${(o.bbox.y / previewPanel.page.image_height) * 100}%`,
                          width: `${(o.bbox.w / previewPanel.page.image_width) * 100}%`,
                          height: `${(o.bbox.h / previewPanel.page.image_height) * 100}%`,
                          borderStyle: 'solid',
                          borderWidth: o.isHovered ? 2 : 1,
                          borderColor: dimmed ? 'transparent' : base,
                          backgroundColor: base + (o.isHovered ? '66' : dimmed ? '26' : '33'),
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
