import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type IdentifierType = 'name' | 'ssn' | 'dob' | 'email' | 'address' | 'other';

interface Identifier {
  type: IdentifierType;
  value: string;
}

const IDENTIFIER_TYPES: { value: IdentifierType; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'ssn', label: 'SSN' },
  { value: 'dob', label: 'Date of Birth' },
  { value: 'email', label: 'Email' },
  { value: 'address', label: 'Address' },
  { value: 'other', label: 'Other' },
];

function formatIdentifierInput(type: IdentifierType, raw: string): string {
  if (type === 'ssn') {
    const digits = raw.replace(/\D/g, '').slice(0, 9);
    if (digits.length <= 3) return digits;
    if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
  if (type === 'dob') {
    const digits = raw.replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }
  return raw;
}

function placeholderFor(type: IdentifierType): string {
  switch (type) {
    case 'name': return 'Jane Doe';
    case 'ssn': return '123-45-6789';
    case 'dob': return 'MM/DD/YYYY';
    case 'email': return 'jane@example.com';
    case 'address': return '123 Main St, City, ST 12345';
    case 'other': return 'Any value';
    default: return '';
  }
}

function validateIdentifier(type: IdentifierType, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (type === 'ssn') return /^\d{3}-\d{2}-\d{4}$/.test(v);
  if (type === 'dob') return /^\d{2}\/\d{2}\/\d{4}$/.test(v);
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  return true;
}

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
  plus: 'M12 5v14 M5 12h14',
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

interface QuotaBadgeBalance {
  free_daily?: { usage: number; granted: number; resets_at?: string };
  free_week1?: { usage: number; granted: number; expires_at?: string };
  prepaid?: { usage: number; granted: number } | null;
}

function QuotaBadge({
  balance,
}: {
  balance: QuotaBadgeBalance | null;
}): JSX.Element {
  if (!balance) {
    return (
      <span className="text-xs text-muted-foreground px-2 py-1 rounded-md bg-secondary border border-border">
        Quota…
      </span>
    );
  }
  const daily = balance.free_daily;
  const w1 = balance.free_week1;
  const prepaid = balance.prepaid;
  const dailyLeft = daily ? Math.max(0, daily.granted - daily.usage) : 0;
  const w1Active = !!w1?.expires_at && new Date(w1.expires_at).getTime() > Date.now();
  const w1Left = w1Active && w1 ? Math.max(0, w1.granted - w1.usage) : 0;
  const prepaidLeft = prepaid ? Math.max(0, prepaid.granted - prepaid.usage) : 0;
  const total = dailyLeft + w1Left + prepaidLeft;
  const empty = total <= 0;
  return (
    <div
      className={
        'flex items-center gap-2 text-xs px-2.5 py-1 rounded-md border ' +
        (empty
          ? 'bg-destructive/10 border-destructive/40 text-destructive'
          : 'bg-secondary border-border text-foreground')
      }
      title={
        [
          daily ? `Daily: ${dailyLeft}/${daily.granted}` : null,
          w1Active && w1 ? `Bonus: ${w1Left}/${w1.granted}` : null,
          prepaid ? `Prepaid: ${prepaidLeft}/${prepaid.granted}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      }
    >
      <span className="font-medium">{total} pages left</span>
      <span className="text-muted-foreground">
        (
        {[
          `${dailyLeft} free today`,
          w1Active && w1 ? `${w1Left} week one bonus` : null,
          prepaid ? `${prepaidLeft} prepaid` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        )
      </span>
    </div>
  );
}

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
  const [identifiersHintOpen, setIdentifiersHintOpen] = useState(false);
  const [scanHintOpen, setScanHintOpen] = useState(false);
  const [identifiersOpen, setIdentifiersOpen] = useState(false);
  const [identifiers, setIdentifiers] = useState<Identifier[]>([]);
  const [identifiersDraft, setIdentifiersDraft] = useState<Identifier[]>([
    { type: 'name', value: '' },
  ]);
  const [identifiersSaving, setIdentifiersSaving] = useState(false);
  const [identifiersShowErrors, setIdentifiersShowErrors] = useState(false);
  const [identifiersShakeRound, setIdentifiersShakeRound] = useState(0);
  const [identifiersShakeIndices, setIdentifiersShakeIndices] = useState<number[]>([]);
  const [paywall, setPaywall] = useState<{
    reason:
      | 'invalid_device'
      | 'insufficient_balance'
      | 'network_error'
      | 'offline_state_missing'
      | 'offline_lease_expired'
      | 'offline_ceiling_reached'
      | 'offline_unavailable';
    requested: number;
    free_daily?: { usage: number; granted: number; resets_at?: string };
    free_week1?: { usage: number; granted: number; expires_at?: string };
    prepaid?: { usage: number; granted: number } | null;
    offline_remaining?: number;
    offline_ceiling?: number;
    lease_expires_at?: string;
    error?: string;
  } | null>(null);

  const [balance, setBalance] = useState<{
    free_daily?: { usage: number; granted: number; resets_at?: string };
    free_week1?: { usage: number; granted: number; expires_at?: string };
    prepaid?: { usage: number; granted: number } | null;
  } | null>(null);

  const refreshBalance = async (): Promise<void> => {
    const r = await window.billing.balance();
    if (r.free_daily || r.free_week1 || r.prepaid !== undefined) {
      setBalance({ free_daily: r.free_daily, free_week1: r.free_week1, prepaid: r.prepaid });
    }
  };

  useEffect(() => {
    void refreshBalance();
  }, []);

  // Per-scan ("temporary") identifiers — used for the current scan only.
  const [scanIdentifiers, setScanIdentifiers] = useState<Identifier[]>([]);
  const [scanIdentifiersOpen, setScanIdentifiersOpen] = useState(false);
  const [scanIdentifiersDraft, setScanIdentifiersDraft] = useState<Identifier[]>([
    { type: 'name', value: '' },
  ]);
  const [scanIdentifiersShowErrors, setScanIdentifiersShowErrors] = useState(false);
  const [scanIdentifiersShakeRound, setScanIdentifiersShakeRound] = useState(0);
  const [scanIdentifiersShakeIndices, setScanIdentifiersShakeIndices] = useState<number[]>([]);

  const openScanIdentifiers = (): void => {
    setScanIdentifiersDraft(
      scanIdentifiers.length > 0 ? scanIdentifiers : [{ type: 'name', value: '' }],
    );
    setScanIdentifiersShowErrors(false);
    setScanIdentifiersOpen(true);
  };

  const updateScanDraftValueAt = (i: number, value: string): void => {
    setScanIdentifiersDraft((prev) =>
      prev.map((row, idx) =>
        idx === i ? { ...row, value: formatIdentifierInput(row.type, value) } : row,
      ),
    );
  };

  const updateScanDraftTypeAt = (i: number, type: IdentifierType): void => {
    setScanIdentifiersDraft((prev) =>
      prev.map((row, idx) =>
        idx === i ? { type, value: formatIdentifierInput(type, row.value) } : row,
      ),
    );
  };

  const removeScanDraftAt = (i: number): void => {
    setScanIdentifiersDraft((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length === 0 ? [{ type: 'name', value: '' }] : next;
    });
    setScanIdentifiersShakeIndices([]);
  };

  const addScanDraftRow = (): void => {
    setScanIdentifiersDraft((prev) => [...prev, { type: 'name', value: '' }]);
    setScanIdentifiersShakeIndices([]);
  };

  const applyScanIdentifiersDraft = (): void => {
    const emptyIndices = scanIdentifiersDraft
      .map((r, idx) => (r.value.trim().length === 0 ? idx : -1))
      .filter((idx) => idx >= 0);
    // Allow a single empty placeholder row when applying — we just drop it.
    const nonEmpty = scanIdentifiersDraft.filter((r) => r.value.trim().length > 0);
    if (nonEmpty.length === 0 && scanIdentifiersDraft.length > 1) {
      setScanIdentifiersShakeIndices(emptyIndices);
      setScanIdentifiersShakeRound((n) => n + 1);
      return;
    }
    const allValid = nonEmpty.every((r) => validateIdentifier(r.type, r.value));
    if (!allValid) {
      setScanIdentifiersShowErrors(true);
      return;
    }
    const cleaned = nonEmpty.map((r) => ({ type: r.type, value: r.value.trim() }));
    setScanIdentifiers(cleaned);
    setScanIdentifiersOpen(false);
  };

  const handleFileSelect = async (): Promise<void> => {
    const picked = await window.dialogApi.openPdf();
    if (picked) {
      // Clear scan-result state but preserve one-off identifiers — the user
      // may have added them in preparation for the file they're picking now.
      setAppState('empty');
      setPiiItems([]);
      setIsScanning(false);
      setIsScrubbing(false);
      setScrubbedPath('');
      setPages(new Map());
      setHoveredValue(null);
      setSelectedFile(picked.name);
      setSelectedFilePath(picked.path);
    }
  };

  useEffect(() => {
    window.identifiers.load().then((res) => {
      if (res.ok) setIdentifiers(res.values);
    });
  }, []);

  useEffect(() => {
    if (!identifiersOpen && !scanIdentifiersOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (scanIdentifiersOpen) setScanIdentifiersOpen(false);
      else if (identifiersOpen) setIdentifiersOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [identifiersOpen, scanIdentifiersOpen]);

  const openIdentifiers = (): void => {
    setIdentifiersDraft(
      identifiers.length > 0 ? identifiers : [{ type: 'name', value: '' }],
    );
    setIdentifiersShowErrors(false);
    setIdentifiersOpen(true);
  };

  const updateDraftValueAt = (i: number, value: string): void => {
    setIdentifiersDraft((prev) =>
      prev.map((row, idx) =>
        idx === i ? { ...row, value: formatIdentifierInput(row.type, value) } : row,
      ),
    );
  };

  const updateDraftTypeAt = (i: number, type: IdentifierType): void => {
    setIdentifiersDraft((prev) =>
      prev.map((row, idx) =>
        idx === i ? { type, value: formatIdentifierInput(type, row.value) } : row,
      ),
    );
  };

  const removeDraftAt = (i: number): void => {
    setIdentifiersDraft((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length === 0 ? [{ type: 'name', value: '' }] : next;
    });
    setIdentifiersShakeIndices([]);
  };

  const addDraftRow = (): void => {
    setIdentifiersDraft((prev) => [...prev, { type: 'name', value: '' }]);
    setIdentifiersShakeIndices([]);
  };

  const saveIdentifiersDraft = async (): Promise<void> => {
    const emptyIndices = identifiersDraft
      .map((r, idx) => (r.value.trim().length === 0 ? idx : -1))
      .filter((idx) => idx >= 0);
    if (emptyIndices.length > 0) {
      setIdentifiersShakeIndices(emptyIndices);
      setIdentifiersShakeRound((n) => n + 1);
      return;
    }
    const allValid = identifiersDraft.every((r) => validateIdentifier(r.type, r.value));
    if (!allValid) {
      setIdentifiersShowErrors(true);
      return;
    }
    const cleaned = identifiersDraft.map((r) => ({ type: r.type, value: r.value.trim() }));
    setIdentifiersSaving(true);
    try {
      const res = await window.identifiers.save(cleaned);
      if (res.ok) {
        setIdentifiers(cleaned);
        setIdentifiersOpen(false);
      } else {
        console.error('identifiers save error:', res.error);
      }
    } finally {
      setIdentifiersSaving(false);
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
    const customPii = [
      ...identifiers.map((i) => ({ value: i.value, type: i.type })),
      ...scanIdentifiers.map((i) => ({ value: i.value, type: i.type })),
    ];
    window.scrubber.detect(selectedFilePath, customPii).then((res) => {
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
    const checked = piiItems.filter((p) => p.checked);
    const selected = checked.map((p) => p.value);
    if (selected.length === 0) return;
    const byType = checked.reduce<Record<string, number>>((acc, p) => {
      acc[p.type] = (acc[p.type] ?? 0) + 1;
      return acc;
    }, {});
    const pageCount = pages.size;
    setIsScrubbing(true);
    try {
      // Quota gate. The combined budget across free_daily + free_week1 +
      // prepaid must cover every page in the PDF — partial scrubs are not
      // allowed (the design's "all-or-nothing per scrub" rule).
      if (pageCount > 0) {
        const quota = await window.billing.consume(pageCount);
        // Mirror the post-consume state into the header badge regardless of
        // outcome — consume returns the latest usage/granted for every bucket.
        if (quota.free_daily || quota.free_week1 || quota.prepaid !== undefined) {
          setBalance({
            free_daily: quota.free_daily,
            free_week1: quota.free_week1,
            prepaid: quota.prepaid ?? null,
          });
        }
        if (!quota.allow) {
          setPaywall({
            reason: quota.reason ?? 'network_error',
            requested: pageCount,
            free_daily: quota.free_daily,
            free_week1: quota.free_week1,
            prepaid: quota.prepaid ?? null,
            offline_remaining: quota.offline_remaining,
            offline_ceiling: quota.offline_ceiling,
            lease_expires_at: quota.lease_expires_at,
            error: quota.error,
          });
          return;
        }
      }
      const res = await window.scrubber.scrub(
        selected,
        HIGHLIGHT_COLORS[highlightColor].base,
        byType,
      );
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
    setScanIdentifiers([]);
  };

  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewBoxSize, setPreviewBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setPreviewBoxSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
          <h1 className="tracking-tight text-base font-semibold">Identity Scrubber</h1>
          <div className="ml-auto">
            <QuotaBadge balance={balance} />
          </div>
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

            {/* Primary action: Run / Re-run Detection */}
            {selectedFile && (
              <button
                onClick={handleDetect}
                disabled={isScanning}
                className="mt-3 w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Icon path={ICONS.scan} className="w-4 h-4" />
                <span className="font-medium">
                  {isScanning
                    ? 'Scanning...'
                    : appState === 'empty'
                      ? 'Run Detection'
                      : 'Re-run Detection'}
                </span>
              </button>
            )}

            <div className="h-px bg-border my-4" />

            <h2 className="font-semibold text-base mb-3">Known Identifiers</h2>

            {/* Detection inputs: persistent ("My Identifiers") + per-scan one-offs. */}
            <div className="grid grid-cols-2 gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={openIdentifiers}
                  onMouseEnter={() => setIdentifiersHintOpen(true)}
                  onMouseLeave={() => setIdentifiersHintOpen(false)}
                  onFocus={() => setIdentifiersHintOpen(true)}
                  onBlur={() => setIdentifiersHintOpen(false)}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 rounded-md transition-colors cursor-pointer"
                >
                  <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
                  <span>Saved Identifiers</span>
                  {identifiers.length > 0 && (
                    <span className="text-primary/70">({identifiers.length})</span>
                  )}
                </button>
                {identifiersHintOpen && !identifiersOpen && (
                  <div
                    role="tooltip"
                    className="absolute left-0 top-full mt-1.5 z-20 w-64 px-3 py-2 bg-secondary border border-border text-foreground text-xs leading-relaxed rounded-lg shadow-md pointer-events-none"
                  >
                    <b>Used in every scan.</b> Saved on this device — for things that are always you, like your name, SSN, or date of birth.
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={openScanIdentifiers}
                  onMouseEnter={() => setScanHintOpen(true)}
                  onMouseLeave={() => setScanHintOpen(false)}
                  onFocus={() => setScanHintOpen(true)}
                  onBlur={() => setScanHintOpen(false)}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-muted-foreground border border-dashed border-border rounded-md hover:text-foreground hover:border-foreground/40 transition-colors cursor-pointer"
                >
                  <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
                  <span>One-off Identifiers</span>
                  {scanIdentifiers.length > 0 && (
                    <span className="text-foreground/70">({scanIdentifiers.length})</span>
                  )}
                </button>
                {scanHintOpen && !scanIdentifiersOpen && (
                  <div
                    role="tooltip"
                    className="absolute left-0 top-full mt-1.5 z-20 w-64 px-3 py-2 bg-secondary border border-border text-foreground text-xs leading-relaxed rounded-lg shadow-md pointer-events-none"
                  >
                    <b>Used in this scan only.</b> Not saved — for values specific to this document, like a case number or counterparty name.
                  </div>
                )}
              </div>
            </div>

            <h2 className="font-semibold text-base mt-5 mb-3">Detected Identifiers</h2>

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

                {appState === 'detected' && (
                  <div className="sticky bottom-0 -mx-5 -mb-5 mt-3 px-5 py-3 bg-card border-t border-border">
                    <button
                      onClick={handleScrub}
                      disabled={isScrubbing || piiItems.filter((p) => p.checked).length === 0}
                      className="w-full px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <Icon path={ICONS.alertTriangle} className="w-4 h-4" />
                      <span className="font-medium">
                        {isScrubbing
                          ? 'Scrubbing...'
                          : piiItems.filter((p) => p.checked).length === 0
                            ? 'Select at least one item'
                            : 'Execute Scrub'}
                      </span>
                    </button>
                  </div>
                )}

                {appState === 'scrubbed' && (
                  <div className="sticky bottom-0 -mx-5 -mb-5 mt-3 px-5 pt-6 pb-6 bg-card border-t border-border flex flex-col gap-3 animate-slide-up-fade">
                    <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex items-center gap-3">
                      <Icon path={ICONS.checkCircle} className="w-6 h-6 text-primary flex-shrink-0 animate-check-pop" />
                      <div className="flex-1 min-w-0 animate-text-fade-in">
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

            <div ref={previewBoxRef} className="flex-1 min-h-0 flex items-center justify-center">
              {!previewPanel && (
                <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  <Icon path={ICONS.file} className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p>Run detection to preview pages.</p>
                  <p className="mt-1">Hover a PII entry to highlight its location.</p>
                </div>
              )}
              {previewPanel && (() => {
                const ar = previewPanel.page.image_width / previewPanel.page.image_height;
                const pw = previewBoxSize.w;
                const ph = previewBoxSize.h;
                const fitW = Math.min(pw, ph * ar);
                const fitH = Math.min(ph, pw / ar);
                return (
                <div
                  className="relative bg-secondary border border-border rounded"
                  style={{ width: fitW, height: fitH }}
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
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {identifiersOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setIdentifiersOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="identifiers-modal-title"
            className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 id="identifiers-modal-title" className="font-semibold text-base">
                Saved Identifiers
              </h3>
              <button
                type="button"
                onClick={() => setIdentifiersOpen(false)}
                aria-label="Close"
                className="p-1 -mr-1 rounded-md text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <Icon path={ICONS.x} className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Saved locally on this device and always included in detection.
            </p>

            <div className="flex flex-col gap-2 mb-3 max-h-[50vh] overflow-y-auto pr-1">
              {identifiersDraft.map((row, i) => {
                const trimmed = row.value.trim();
                const invalid =
                  identifiersShowErrors &&
                  trimmed.length > 0 &&
                  !validateIdentifier(row.type, row.value);
                return (
                  <div key={i} className="flex items-start gap-2">
                    <select
                      value={row.type}
                      onChange={(e) => updateDraftTypeAt(i, e.target.value as IdentifierType)}
                      className="px-2 py-2 text-sm bg-secondary border border-border rounded-md outline-none focus:border-primary/50 focus:bg-card transition-colors cursor-pointer flex-shrink-0 w-32"
                    >
                      {IDENTIFIER_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <div className="flex-1 min-w-0">
                      <input
                        key={`val-${i}-${identifiersShakeIndices.includes(i) ? identifiersShakeRound : 0}`}
                        type="text"
                        value={row.value}
                        onChange={(e) => updateDraftValueAt(i, e.target.value)}
                        placeholder={placeholderFor(row.type)}
                        inputMode={row.type === 'ssn' || row.type === 'dob' ? 'numeric' : undefined}
                        className={`w-full px-3 py-2 text-sm bg-secondary border rounded-md outline-none focus:bg-card transition-colors placeholder:text-muted-foreground/40 ${
                          invalid
                            ? 'border-primary ring-2 ring-primary/20 focus:border-primary'
                            : 'border-border focus:border-primary/50'
                        } ${
                          identifiersShakeIndices.includes(i) && row.value.trim().length === 0
                            ? 'animate-shake border-primary ring-2 ring-primary/20'
                            : ''
                        }`}
                      />
                      {invalid && (
                        <p className="text-xs text-primary mt-1">
                          {row.type === 'ssn' && 'Format: 123-45-6789'}
                          {row.type === 'dob' && 'Format: MM/DD/YYYY'}
                          {row.type === 'email' && 'Enter a valid email address'}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeDraftAt(i)}
                      aria-label="Remove identifier"
                      title="Remove"
                      className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex-shrink-0"
                    >
                      <Icon path={ICONS.x} className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={addDraftRow}
              className="self-start inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline mb-5 cursor-pointer"
            >
              <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
              Add another
            </button>

            <div className="flex justify-end gap-2 pt-3 border-t border-border">
              <button
                type="button"
                onClick={() => setIdentifiersOpen(false)}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveIdentifiersDraft}
                disabled={identifiersSaving}
                className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {identifiersSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {scanIdentifiersOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setScanIdentifiersOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-identifiers-modal-title"
            className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 id="scan-identifiers-modal-title" className="font-semibold text-base">
                One-off Identifiers
              </h3>
              <button
                type="button"
                onClick={() => setScanIdentifiersOpen(false)}
                aria-label="Close"
                className="p-1 -mr-1 rounded-md text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <Icon path={ICONS.x} className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Used for this scan only. Not saved — for values specific to this document, like a case number or counterparty name.
            </p>

            <div className="flex flex-col gap-2 mb-3 max-h-[50vh] overflow-y-auto pr-1">
              {scanIdentifiersDraft.map((row, i) => {
                const trimmed = row.value.trim();
                const invalid =
                  scanIdentifiersShowErrors &&
                  trimmed.length > 0 &&
                  !validateIdentifier(row.type, row.value);
                return (
                  <div key={i} className="flex items-start gap-2">
                    <select
                      value={row.type}
                      onChange={(e) => updateScanDraftTypeAt(i, e.target.value as IdentifierType)}
                      className="px-2 py-2 text-sm bg-secondary border border-border rounded-md outline-none focus:border-primary/50 focus:bg-card transition-colors cursor-pointer flex-shrink-0 w-32"
                    >
                      {IDENTIFIER_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <div className="flex-1 min-w-0">
                      <input
                        key={`scan-val-${i}-${scanIdentifiersShakeIndices.includes(i) ? scanIdentifiersShakeRound : 0}`}
                        type="text"
                        value={row.value}
                        onChange={(e) => updateScanDraftValueAt(i, e.target.value)}
                        placeholder={placeholderFor(row.type)}
                        inputMode={row.type === 'ssn' || row.type === 'dob' ? 'numeric' : undefined}
                        className={`w-full px-3 py-2 text-sm bg-secondary border rounded-md outline-none focus:bg-card transition-colors placeholder:text-muted-foreground/40 ${
                          invalid
                            ? 'border-primary ring-2 ring-primary/20 focus:border-primary'
                            : 'border-border focus:border-primary/50'
                        } ${
                          scanIdentifiersShakeIndices.includes(i) && row.value.trim().length === 0
                            ? 'animate-shake border-primary ring-2 ring-primary/20'
                            : ''
                        }`}
                      />
                      {invalid && (
                        <p className="text-xs text-primary mt-1">
                          {row.type === 'ssn' && 'Format: 123-45-6789'}
                          {row.type === 'dob' && 'Format: MM/DD/YYYY'}
                          {row.type === 'email' && 'Enter a valid email address'}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeScanDraftAt(i)}
                      aria-label="Remove identifier"
                      title="Remove"
                      className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer flex-shrink-0"
                    >
                      <Icon path={ICONS.x} className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={addScanDraftRow}
              className="self-start inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline mb-5 cursor-pointer"
            >
              <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
              Add another
            </button>

            <div className="flex justify-end gap-2 pt-3 border-t border-border">
              <button
                type="button"
                onClick={() => setScanIdentifiersOpen(false)}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyScanIdentifiersDraft}
                className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors cursor-pointer"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {paywall && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPaywall(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-base">
              {paywall.reason === 'insufficient_balance'
                ? 'Not enough pages'
                : paywall.reason === 'invalid_device'
                  ? 'Device verification failed'
                  : paywall.reason === 'offline_ceiling_reached'
                    ? 'Offline quota exhausted'
                    : paywall.reason === 'offline_lease_expired'
                      ? 'Offline quota expired'
                      : paywall.reason === 'offline_state_missing' ||
                          paywall.reason === 'offline_unavailable'
                        ? 'Offline quota unavailable'
                        : 'Quota service unavailable'}
            </h3>

            {paywall.reason === 'insufficient_balance' && (
              <>
                <p className="text-sm text-muted-foreground">
                  This PDF needs {paywall.requested} page(s) but your remaining quota is lower.
                </p>
                <div className="text-xs flex flex-col gap-1 bg-secondary rounded-md p-3">
                  {paywall.free_daily && (
                    <div className="flex justify-between">
                      <span>Daily free</span>
                      <span>
                        {Math.max(0, paywall.free_daily.granted - paywall.free_daily.usage)} /{' '}
                        {paywall.free_daily.granted}
                        {paywall.free_daily.resets_at
                          ? ` · resets ${new Date(paywall.free_daily.resets_at).toLocaleString()}`
                          : ''}
                      </span>
                    </div>
                  )}
                  {paywall.free_week1 && (
                    <div className="flex justify-between">
                      <span>First-week bonus</span>
                      <span>
                        {paywall.free_week1.expires_at &&
                        new Date(paywall.free_week1.expires_at).getTime() > Date.now()
                          ? `${Math.max(0, paywall.free_week1.granted - paywall.free_week1.usage)} / ${paywall.free_week1.granted}`
                          : 'expired'}
                      </span>
                    </div>
                  )}
                  {paywall.prepaid && (
                    <div className="flex justify-between">
                      <span>Prepaid</span>
                      <span>
                        {Math.max(0, paywall.prepaid.granted - paywall.prepaid.usage)} /{' '}
                        {paywall.prepaid.granted}
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}

            {paywall.reason === 'invalid_device' && (
              <p className="text-sm text-muted-foreground">
                We couldn't verify this device. Try restarting the app, or contact support if this
                keeps happening.
              </p>
            )}

            {paywall.reason === 'network_error' && (
              <p className="text-sm text-muted-foreground">
                Couldn't reach the quota service{paywall.error ? ` (${paywall.error})` : ''}. Check
                your connection and try again.
              </p>
            )}

            {paywall.reason === 'offline_ceiling_reached' && (
              <p className="text-sm text-muted-foreground">
                You've used all {paywall.offline_ceiling ?? 0} pages of your offline quota. Connect
                to the internet to continue scrubbing.
              </p>
            )}

            {paywall.reason === 'offline_lease_expired' && (
              <p className="text-sm text-muted-foreground">
                Your offline quota has expired
                {paywall.lease_expires_at
                  ? ` (${new Date(paywall.lease_expires_at).toLocaleString()})`
                  : ''}
                . Connect to the internet to continue scrubbing.
              </p>
            )}

            {(paywall.reason === 'offline_state_missing' ||
              paywall.reason === 'offline_unavailable') && (
              <p className="text-sm text-muted-foreground">
                Offline scrubbing isn't available right now
                {paywall.reason === 'offline_state_missing'
                  ? ' (no local quota cached, or the cache was modified)'
                  : ''}
                . Connect to the internet to continue.
              </p>
            )}

            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setPaywall(null)}
                className="px-4 py-1.5 text-sm font-medium bg-secondary border border-border rounded-md hover:bg-secondary/80 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
