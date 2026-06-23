import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BuyModal } from './BuyModal';

/**
 * A trigger wrapped with a styled hover/focus tooltip ("info widget"). The
 * tooltip appears below the trigger on hover or keyboard focus. Pass
 * `disabled` to suppress it (e.g. while a related editor/modal is open).
 */
function InfoHint({
  hint,
  disabled = false,
  className,
  children,
}: {
  hint: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={'relative' + (className ? ' ' + className : '')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && !disabled && (
        <div
          role="tooltip"
          className="absolute left-0 top-full mt-1.5 z-20 w-64 px-3 py-2 bg-secondary border border-border text-foreground text-xs leading-relaxed rounded-lg shadow-md pointer-events-none"
        >
          {hint}
        </div>
      )}
    </div>
  );
}

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
  | { phase: 'ocr'; page?: number; total?: number }
  | { phase: 'analyze'; chunk: number; total: number };

function statusText(s: DetectStatus | null): string {
  if (!s) return 'Analyzing document for PII…';
  if (s.phase === 'ocr') {
    if (typeof s.page === 'number' && typeof s.total === 'number' && s.total > 0) {
      const pct = Math.round((s.page / s.total) * 100);
      return `Reading text from the PDF (${pct}%)…`;
    }
    return 'Loading detection model…';
  }
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
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
};

function NavButton({
  dir,
  onClick,
  disabled,
  label,
}: {
  dir: 'prev' | 'next';
  onClick: () => void;
  disabled: boolean;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex items-center justify-center w-7 h-7 rounded-md border border-border bg-secondary hover:bg-secondary/60 hover:border-foreground/30 disabled:opacity-30 disabled:hover:bg-secondary disabled:hover:border-border disabled:cursor-default transition-colors cursor-pointer"
    >
      <Icon
        path={dir === 'prev' ? ICONS.chevronLeft : ICONS.chevronRight}
        className="w-4 h-4"
      />
    </button>
  );
}

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

interface LicenseView {
  id: number;
  sku: string;
  tier: string | null;
  quota_total: number;
  amount_cents: number | null;
  provider_order_id: string | null;
  created_at: string;
}

function QuotaBadge({
  balance,
  error,
  onRetry,
  onBuy,
  onShowDetails,
}: {
  balance: QuotaBadgeBalance | null;
  error: string | null;
  onRetry: () => void;
  onBuy: () => void;
  onShowDetails: () => void;
}): JSX.Element {
  if (!balance) {
    // A failed load (no balance returned) shows a clickable error chip rather
    // than sitting on the "Quota…" loading state forever.
    if (error) {
      return (
        <button
          type="button"
          onClick={onRetry}
          title={`Couldn't load quota (${error}). Click to retry.`}
          className="text-xs px-2 py-1 rounded-md bg-destructive/10 border border-destructive/40 text-destructive hover:bg-destructive/20 transition-colors cursor-pointer"
        >
          Quota unavailable · retry
        </button>
      );
    }
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
  const showW1 = w1Active && !!w1 && w1Left > 0;
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
          showW1 && w1 ? `Bonus: ${w1Left}/${w1.granted}` : null,
          prepaid ? `Prepaid: ${prepaidLeft}/${prepaid.granted}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      }
    >
      <InfoHint hint="Show balance details">
        <button
          type="button"
          onClick={onShowDetails}
          aria-label="Show balance details"
          className="flex items-center gap-2 cursor-pointer rounded -my-1 -mx-1 py-1 px-1 hover:bg-foreground/5 focus:outline-none transition-colors"
        >
          <span className="font-medium">{total} pages left</span>
          <span className="text-muted-foreground">
            (
            {[
              `${dailyLeft} free today`,
              showW1 && w1 ? `${w1Left} week one bonus` : null,
              prepaid ? `${prepaidLeft} prepaid` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            )
          </span>
        </button>
      </InfoHint>
      <button
        type="button"
        onClick={onBuy}
        title="Buy more pages"
        aria-label="Buy more pages"
        className="ml-1 -mr-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors cursor-pointer"
      >
        <Icon path={ICONS.plus} className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

function formatTier(tier: string | null): string {
  if (!tier) return 'Prepaid';
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Compact acquired stamp: "May 16   2:30 AM" — drops the year and seconds,
// and pads the gap between date and time with spaces so that, when rendered
// in a monospace font with `whitespace-pre`, every row's date sits flush
// left and its time sits flush right within a fixed character width.
// Width budget: 6 chars for "MMM DD" + 8 chars for "HH:MM AM" + filler.
const ACQUIRED_WIDTH = 15;

function formatAcquired(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const gap = Math.max(1, ACQUIRED_WIDTH - date.length - time.length);
  return date + ' '.repeat(gap) + time;
}

function BalanceDetailsModal({
  open,
  onClose,
  balance,
  licenses,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  balance: QuotaBadgeBalance | null;
  licenses: LicenseView[] | null;
  loading: boolean;
  error: string | null;
}): JSX.Element | null {
  if (!open) return null;

  const daily = balance?.free_daily;
  const w1 = balance?.free_week1;
  const prepaid = balance?.prepaid ?? null;
  const dailyLeft = daily ? Math.max(0, daily.granted - daily.usage) : 0;
  const w1Active = !!w1?.expires_at && new Date(w1.expires_at).getTime() > Date.now();
  const w1Left = w1Active && w1 ? Math.max(0, w1.granted - w1.usage) : 0;
  // Once the week-one bonus is expired or drained it never comes back, so
  // hide its tile entirely rather than showing a permanent "0 / 20" stub.
  const showW1 = w1Active && w1Left > 0;
  const prepaidLeft = prepaid ? Math.max(0, prepaid.granted - prepaid.usage) : 0;
  const totalLeft = dailyLeft + w1Left + prepaidLeft;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col gap-4 max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-base">Quota details</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalLeft} pages left across all buckets
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Icon path={ICONS.x} className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Balance
          </div>
          <div className={'grid gap-2 ' + (showW1 ? 'grid-cols-3' : 'grid-cols-2')}>
            <div className="rounded-lg border border-border bg-secondary px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Free today</div>
              <div className="text-sm font-semibold">
                {dailyLeft}
                {daily ? <span className="text-muted-foreground font-normal"> / {daily.granted}</span> : null}
              </div>
              {daily?.resets_at && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  resets {formatDateTime(daily.resets_at)}
                </div>
              )}
            </div>
            {showW1 && w1 && (
              <div className="rounded-lg border border-border bg-secondary px-3 py-2">
                <div className="text-[11px] text-muted-foreground">First-week bonus</div>
                <div className="text-sm font-semibold">
                  {w1Left}
                  <span className="text-muted-foreground font-normal"> / {w1.granted}</span>
                </div>
                {w1.expires_at && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    expires {formatDateTime(w1.expires_at)}
                  </div>
                )}
              </div>
            )}
            <div className="rounded-lg border border-border bg-secondary px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Prepaid</div>
              <div className="text-sm font-semibold">
                {prepaidLeft}
                {prepaid ? <span className="text-muted-foreground font-normal"> / {prepaid.granted}</span> : null}
              </div>
              {!prepaid && (
                <div className="text-[11px] text-muted-foreground mt-0.5">no prepaid pages yet</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 min-h-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Purchased licenses
            </div>
            <div className="text-[11px] text-muted-foreground">
              Showing the 10 most recent
            </div>
          </div>
          {loading && !licenses && (
            <div className="text-sm text-muted-foreground">Loading licenses…</div>
          )}
          {error && (
            <div className="text-sm text-destructive">
              Couldn't load licenses ({error}). The list is only available online.
            </div>
          )}
          {licenses && licenses.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground">
              No purchases yet. Use the “+” next to the badge to buy pages.
            </div>
          )}
          {licenses && licenses.length > 0 && (
            <div className="overflow-auto rounded-lg border border-border max-h-72">
              <table className="w-full text-xs">
                <thead className="bg-secondary text-muted-foreground sticky top-0 z-10 shadow-[0_1px_0_0_var(--border)]">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Type</th>
                    <th className="text-right font-medium px-3 py-2">Pages</th>
                    <th className="text-right font-medium px-3 py-2">Price</th>
                    <th className="text-right font-medium px-3 py-2">Acquired</th>
                  </tr>
                </thead>
                <tbody>
                  {licenses.map((lic) => {
                    const acquired = formatAcquired(lic.created_at);
                    return (
                      <tr key={lic.id} className="border-t border-border">
                        <td className="px-3 py-2 font-medium text-foreground capitalize">
                          {formatTier(lic.tier)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {lic.quota_total.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {lic.amount_cents == null
                            ? '—'
                            : `$${(lic.amount_cents / 100).toFixed(
                                lic.amount_cents % 100 === 0 ? 0 : 2,
                              )}`}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground whitespace-pre font-mono">
                          {acquired}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
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
  // A value the user clicked to "pin" — the preview then locks onto it and the
  // header shows a stepper to walk through each of its occurrences. Hover is a
  // transient peek; pinning survives moving the mouse into the preview.
  const [pinnedValue, setPinnedValue] = useState<string | null>(null);
  const [pinnedMatchIndex, setPinnedMatchIndex] = useState(0);
  // Which document page the preview shows while just browsing (nothing pinned
  // or hovered) — an index into the sorted list of available pages.
  const [browsePageIndex, setBrowsePageIndex] = useState(0);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('red');
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [detectStatus, setDetectStatus] = useState<DetectStatus | null>(null);
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
      | 'offline_unavailable'
      | 'secure_storage_unavailable';
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
  // Reason/error string when the balance couldn't be loaded, so the badge can
  // show an actionable error instead of a permanent "Quota…" loading state.
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Server tells us when it had to charge a "missing offline_lease report"
  // penalty (see billing.service.ts). We show a dismissable banner the first
  // time we see a given lease_issued_at — the key is persisted so a refresh
  // doesn't keep re-showing the same notice.
  const PENALTY_DISMISS_KEY = 'idscrubber:dismissedPenaltyLeaseIssuedAt';
  const [offlinePenalty, setOfflinePenalty] = useState<{
    charged: number;
    lease_issued_at: string;
  } | null>(null);

  const notePenalty = (
    p: { charged: number; lease_issued_at: string } | undefined,
  ): void => {
    if (!p || p.charged <= 0) return;
    if (localStorage.getItem(PENALTY_DISMISS_KEY) === p.lease_issued_at) return;
    setOfflinePenalty(p);
  };

  const dismissPenalty = (): void => {
    if (offlinePenalty) {
      localStorage.setItem(PENALTY_DISMISS_KEY, offlinePenalty.lease_issued_at);
    }
    setOfflinePenalty(null);
  };

  const refreshBalance = async (): Promise<void> => {
    const r = await window.billing.balance();
    if (r.free_daily || r.free_week1 || r.prepaid !== undefined) {
      setBalance({ free_daily: r.free_daily, free_week1: r.free_week1, prepaid: r.prepaid });
      setBalanceError(null);
    } else if (!r.ok) {
      // No balance came back — surface it on the badge instead of leaving it
      // stuck on the "Quota…" loading state forever.
      setBalanceError(r.reason ?? r.error ?? 'unavailable');
    }
    // If secure storage can't be read, tell the user up front rather than
    // waiting for a scrub to fail — the app can't track usage without it.
    if (!r.ok && r.reason === 'secure_storage_unavailable') {
      setPaywall({ reason: 'secure_storage_unavailable', requested: 0, error: r.error });
    }
    notePenalty(r.offline_penalty);
  };

  const [buyOpen, setBuyOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [licenses, setLicenses] = useState<LicenseView[] | null>(null);
  const [licensesLoading, setLicensesLoading] = useState(false);
  const [licensesError, setLicensesError] = useState<string | null>(null);

  const openDetails = async (): Promise<void> => {
    setDetailsOpen(true);
    setLicensesLoading(true);
    setLicensesError(null);
    const r = await window.billing.balance({ includeLicenses: true });
    if (r.free_daily || r.free_week1 || r.prepaid !== undefined) {
      setBalance({ free_daily: r.free_daily, free_week1: r.free_week1, prepaid: r.prepaid });
    }
    notePenalty(r.offline_penalty);
    if (r.licenses) {
      setLicenses(r.licenses);
    } else if (!r.ok) {
      setLicensesError(r.error ?? r.reason ?? 'offline');
    } else {
      setLicenses([]);
    }
    setLicensesLoading(false);
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

  const togglePin = (value: string): void => {
    setPinnedValue((cur) => (cur === value ? null : value));
    setPinnedMatchIndex(0);
  };

  // Esc clears the pin (when no modal is handling Esc first).
  useEffect(() => {
    if (!pinnedValue) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !identifiersOpen && !scanIdentifiersOpen) {
        setPinnedValue(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedValue, identifiersOpen, scanIdentifiersOpen]);

  // Drop the pin if its value is no longer among the detected items (e.g. after
  // re-running detection).
  useEffect(() => {
    if (pinnedValue && !piiItems.some((p) => p.value === pinnedValue)) {
      setPinnedValue(null);
    }
  }, [piiItems, pinnedValue]);

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
      setPinnedValue(null);
      setBrowsePageIndex(0);
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
      if (evt.cmd !== 'detect') {
        return;
      }
      if (evt.kind === 'page') {
        const pageNum = evt.page_num as number | undefined;
        const imagePath = evt.image_path as string | undefined;
        const imgW = evt.image_width as number | undefined;
        const imgH = evt.image_height as number | undefined;
        if (!pageNum || !imagePath || !imgW || !imgH) {
          return;
        }
        setPages((prev) => {
          const next = new Map(prev);
          next.set(pageNum, { image_path: imagePath, image_width: imgW, image_height: imgH });
          return next;
        });
      } else if (evt.kind === 'pii') {
        const item = evt.item as { type: string; value: string } | undefined;
        if (!item) {
          return;
        }
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
      } else if (evt.phase === 'ocr' && evt.status === 'in_progress') {
        const page = evt.page as number | undefined;
        const total = evt.total as number | undefined;
        if (typeof page === 'number' && typeof total === 'number') {
          setDetectStatus({ phase: 'ocr', page, total });
        }
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
    setPinnedValue(null);
    setBrowsePageIndex(0);
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
        notePenalty(quota.offline_penalty);
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
    setPinnedValue(null);
    setBrowsePageIndex(0);
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
    // A pinned value takes over; otherwise the hovered value drives a peek.
    const activeValue = pinnedValue ?? hoveredValue;
    const active = activeValue
      ? piiItems.find((p) => p.value === activeValue)
      : null;

    // Every occurrence of the active value, ordered top-to-bottom across pages,
    // so the stepper walks them in reading order.
    const activeBboxes = active
      ? [...active.bboxes].sort(
          (a, b) => a.page_num - b.page_num || a.y - b.y || a.x - b.x,
        )
      : [];

    // When pinned, the stepper picks which occurrence (and therefore page) to
    // show; when only hovering, peek at the first occurrence's page.
    const matchIndex = pinnedValue
      ? Math.min(pinnedMatchIndex, Math.max(0, activeBboxes.length - 1))
      : 0;
    const focusedBbox = pinnedValue ? activeBboxes[matchIndex] ?? null : null;

    // All available document pages, in order — used for the browse navigator
    // when nothing is pinned or hovered.
    const sortedPages = Array.from(pages.keys()).sort((a, b) => a - b);
    const browseIndex = Math.min(browsePageIndex, Math.max(0, sortedPages.length - 1));
    const browsePage = sortedPages[browseIndex] ?? null;

    const pageNum =
      focusedBbox?.page_num ??
      activeBboxes[0]?.page_num ??
      browsePage;
    if (pageNum == null) return null;
    const page = pages.get(pageNum);
    if (!page) return null;

    const overlays = piiItems.flatMap((p) =>
      p.checked
        ? p.bboxes
            .filter((b) => b.page_num === pageNum)
            .map((b) => ({
              bbox: b,
              value: p.value,
              isActive: p.value === activeValue,
              isFocused: b === focusedBbox,
            }))
        : [],
    );
    return {
      page,
      pageNum,
      overlays,
      activeValue,
      activeMatchCount: activeBboxes.length,
      matchIndex,
      isPinned: pinnedValue != null && active != null,
      pageCount: sortedPages.length,
      browseIndex,
    };
  }, [hoveredValue, pinnedValue, pinnedMatchIndex, browsePageIndex, piiItems, pages]);

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

      <div className="size-full flex flex-col p-6">
        {offlinePenalty && (
          <div className="mb-4 flex items-start gap-3 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
            <Icon path={ICONS.alertTriangle} className="w-5 h-5 mt-0.5 flex-shrink-0 text-amber-600" />
            <div className="flex-1 text-sm">
              <div className="font-semibold">
                {offlinePenalty.charged} page{offlinePenalty.charged === 1 ? '' : 's'} deducted
              </div>
              <div className="text-amber-800 mt-0.5">
                Your local quota file was missing or tampered with after offline use &mdash; this looks like an attempt to bypass quota tracking. We charged the full offline allowance against your balance to prevent abuse. If this was a genuine mistake, contact support.
              </div>
            </div>
            <button
              onClick={dismissPenalty}
              className="flex-shrink-0 p-1 rounded hover:bg-amber-100 text-amber-700 transition-colors"
              aria-label="Dismiss"
              title="Dismiss"
            >
              <Icon path={ICONS.x} className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="mb-4 flex items-center gap-2">
          <div className="w-7 h-7 bg-primary/10 border border-primary rounded-md flex items-center justify-center">
            <Icon path={ICONS.shield} className="w-4 h-4 text-primary" />
          </div>
          <h1 className="tracking-tight text-base font-semibold">Identity Scrubber</h1>
          <div className="ml-auto flex items-center gap-2">
            <QuotaBadge
              balance={balance}
              error={balanceError}
              onRetry={() => void refreshBalance()}
              onBuy={() => setBuyOpen(true)}
              onShowDetails={() => void openDetails()}
            />
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
              <InfoHint
                disabled={identifiersOpen}
                hint={
                  <>
                    <b>Used in every scan.</b> Saved on this device — for things that are always you, like your name, SSN, or date of birth.
                  </>
                }
              >
                <button
                  type="button"
                  onClick={openIdentifiers}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 rounded-md transition-colors cursor-pointer"
                >
                  <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
                  <span>Saved Identifiers</span>
                  {identifiers.length > 0 && (
                    <span className="text-primary/70">({identifiers.length})</span>
                  )}
                </button>
              </InfoHint>
              <InfoHint
                disabled={scanIdentifiersOpen}
                hint={
                  <>
                    <b>Used in this scan only.</b> Not saved — for values specific to this document, like a case number or counterparty name.
                  </>
                }
              >
                <button
                  type="button"
                  onClick={openScanIdentifiers}
                  className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-muted-foreground border border-dashed border-border rounded-md hover:text-foreground hover:border-foreground/40 transition-colors cursor-pointer"
                >
                  <Icon path={ICONS.plus} className="w-3.5 h-3.5" />
                  <span>One-off Identifiers</span>
                  {scanIdentifiers.length > 0 && (
                    <span className="text-foreground/70">({scanIdentifiers.length})</span>
                  )}
                </button>
              </InfoHint>
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
                  {isScanning && (
                    <div className="bg-secondary/50 border border-border border-dashed rounded-lg p-4 flex items-center gap-3">
                      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm text-muted-foreground">
                        {statusText(detectStatus)}
                      </span>
                    </div>
                  )}
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
                              const isPinned = pinnedValue === item.value;
                              const pageSpan = new Set(item.bboxes.map((b) => b.page_num)).size;
                              return (
                                <div
                                  key={`${item.type}:${item.value}`}
                                  className={`flex items-start gap-3 -mx-1 px-1 py-0.5 rounded cursor-pointer ${
                                    isPinned
                                      ? 'bg-primary/10 ring-1 ring-primary/40'
                                      : isHovered
                                        ? 'bg-primary/10'
                                        : ''
                                  }`}
                                  onMouseEnter={() => setHoveredValue(item.value)}
                                  onMouseLeave={() =>
                                    setHoveredValue((v) => (v === item.value ? null : v))
                                  }
                                  onClick={() => togglePin(item.value)}
                                  title={
                                    pageSpan > 1
                                      ? `Appears on ${pageSpan} pages — click to step through them`
                                      : isPinned
                                        ? 'Click to unpin'
                                        : 'Click to lock the preview on this value'
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={item.checked}
                                    onChange={() => handleTogglePII(index)}
                                    onClick={(e) => e.stopPropagation()}
                                    disabled={appState === 'scrubbed'}
                                    className="mt-0.5 w-5 h-5 accent-primary cursor-pointer disabled:cursor-not-allowed flex-shrink-0"
                                  />
                                  <p className={`flex-1 min-w-0 text-foreground/70 break-words ${isScrubbed ? 'line-through opacity-60' : ''}`}>
                                    {item.value}
                                  </p>
                                  <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                                    {pageSpan > 1 && (
                                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                        {pageSpan} pages
                                      </span>
                                    )}
                                    {item.count > 1 && (
                                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                                        ×{item.count}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    });
                  })()}

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
            <div className="relative flex items-center mb-3">
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
              {/* Navigator: steps through a pinned value's matches, or browses
                  all document pages. Absolutely centered on the header line so
                  it stays in the middle regardless of the title's width. */}
              <div className="absolute left-1/2 -translate-x-1/2">
                {previewPanel &&
                (previewPanel.isPinned && previewPanel.activeMatchCount > 1 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <NavButton
                      dir="prev"
                      onClick={() => setPinnedMatchIndex((i) => Math.max(0, i - 1))}
                      disabled={previewPanel.matchIndex <= 0}
                      label="Previous match"
                    />
                    <span className="text-foreground font-medium tabular-nums">
                      Match {previewPanel.matchIndex + 1} of {previewPanel.activeMatchCount}
                    </span>
                    <NavButton
                      dir="next"
                      onClick={() =>
                        setPinnedMatchIndex((i) =>
                          Math.min(previewPanel.activeMatchCount - 1, i + 1),
                        )
                      }
                      disabled={previewPanel.matchIndex >= previewPanel.activeMatchCount - 1}
                      label="Next match"
                    />
                    <span className="text-muted-foreground/50">·</span>
                    <span>Page {previewPanel.pageNum}</span>
                  </div>
                ) : previewPanel.activeValue ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="text-foreground font-medium tabular-nums">
                      {previewPanel.activeMatchCount} Match
                      {previewPanel.activeMatchCount === 1 ? '' : 'es'}
                    </span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>Page {previewPanel.pageNum}</span>
                  </div>
                ) : previewPanel.pageCount > 1 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <NavButton
                      dir="prev"
                      onClick={() => setBrowsePageIndex((i) => Math.max(0, i - 1))}
                      disabled={previewPanel.browseIndex <= 0}
                      label="Previous page"
                    />
                    <span className="text-foreground font-medium tabular-nums">
                      Page {previewPanel.pageNum} / {previewPanel.pageCount}
                    </span>
                    <NavButton
                      dir="next"
                      onClick={() =>
                        setBrowsePageIndex((i) => Math.min(previewPanel.pageCount - 1, i + 1))
                      }
                      disabled={previewPanel.browseIndex >= previewPanel.pageCount - 1}
                      label="Next page"
                    />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {previewPanel.pageNum} / {previewPanel.pageCount}
                    {` · ${previewPanel.overlays.length} highlight${
                      previewPanel.overlays.length === 1 ? '' : 's'
                    }`}
                  </span>
                ))}
              </div>
            </div>

            <div ref={previewBoxRef} className="flex-1 min-h-0 flex items-center justify-center">
              {!previewPanel && (
                <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  <Icon path={ICONS.file} className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p>Run detection to preview pages.</p>
                  <p className="mt-1">Hover a PII entry to highlight it; click to step through every page it appears on.</p>
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
                    const anyActive = previewPanel.activeValue != null;
                    const dimmed = anyActive && !o.isActive;
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
                          borderWidth: o.isActive ? 2 : 1,
                          borderColor: dimmed ? 'transparent' : base,
                          backgroundColor:
                            base + (o.isFocused ? '80' : o.isActive ? '66' : dimmed ? '26' : '33'),
                          // The pinned-and-stepped-to occurrence gets a ring so
                          // it stands out from other matches of the same value
                          // sharing the page.
                          boxShadow: o.isFocused ? `0 0 0 2px ${base}` : undefined,
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
                  : paywall.reason === 'secure_storage_unavailable'
                    ? 'Keychain access needed'
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

            {paywall.reason === 'secure_storage_unavailable' && (
              <p className="text-sm text-muted-foreground">
                Identity Scrubber couldn't access your Mac's Keychain, which it uses to securely
                track your usage. Please restart the app and try again. If this keeps happening,
                contact support.
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
              {paywall.reason === 'insufficient_balance' && (
                <button
                  type="button"
                  onClick={() => {
                    setPaywall(null);
                    setBuyOpen(true);
                  }}
                  className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  Buy more pages
                </button>
              )}
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

      <BuyModal
        open={buyOpen}
        onClose={() => setBuyOpen(false)}
        initialPrepaid={balance?.prepaid ?? null}
        onPrepaidChanged={() => {
          void refreshBalance();
        }}
      />

      <BalanceDetailsModal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        balance={balance}
        licenses={licenses}
        loading={licensesLoading}
        error={licensesError}
      />
    </div>
  );
}
