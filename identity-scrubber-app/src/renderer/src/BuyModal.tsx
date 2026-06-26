import { JSX, useEffect, useState } from 'react';
import type { Tier } from '../../preload/index';

type Phase =
  | { kind: 'choose' }
  | { kind: 'waiting'; tier: Tier; startedAt: number; testMode: boolean }
  | { kind: 'success'; pagesAdded: number }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

interface PrepaidView {
  usage: number;
  granted: number;
}

interface CatalogueEntry {
  tier: Tier;
  pages: number;
  price_cents: number;
  // Wording mirrors the website pricing section (webserver/content/index.html).
  perPage: string;
  note: string;
  badge?: string;
}

// Catalogue lives in the renderer — prices are stable enough that a server
// round-trip on every modal open isn't worth coupling the buy flow to the
// service being up. The service still validates the tier on /checkout-url
// and the webhook is the only thing that actually grants pages.
const CATALOGUE: CatalogueEntry[] = [
  { tier: 'starter', pages: 100, price_cents: 900, perPage: '9¢ per page', note: 'never expires' },
  {
    tier: 'pro',
    pages: 500,
    price_cents: 1900,
    perPage: '3.8¢ per page',
    note: 'Save 58% vs Starter',
    badge: 'Best value',
  },
  { tier: 'max', pages: 2000, price_cents: 4900, perPage: '2.5¢ per page', note: 'Best for high volume' },
];

const POLL_INTERVAL_MS = 5_000;
const POLL_WINDOW_MS = 5 * 60_000;

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function prepaidRemaining(p: PrepaidView | null | undefined): number {
  if (!p) return 0;
  return Math.max(0, p.granted - p.usage);
}

export function BuyModal({
  open,
  onClose,
  initialPrepaid,
  onPrepaidChanged,
}: {
  open: boolean;
  onClose: () => void;
  initialPrepaid: PrepaidView | null | undefined;
  onPrepaidChanged: () => void;
}): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [selectedTier, setSelectedTier] = useState<Tier>('pro');

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'choose' });
    setSelectedTier('pro');
  }, [open]);

  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const baselineRemaining = prepaidRemaining(initialPrepaid);
    const startedAt = phase.startedAt;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const r = await window.billing.balance();
      const remaining = prepaidRemaining(r.prepaid);
      if (remaining > baselineRemaining) {
        const added = remaining - baselineRemaining;
        setPhase({ kind: 'success', pagesAdded: added });
        onPrepaidChanged();
        return;
      }
      if (Date.now() - startedAt >= POLL_WINDOW_MS) {
        setPhase({ kind: 'timeout' });
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS) as unknown as number;
    };
    let timer: number = setTimeout(tick, POLL_INTERVAL_MS) as unknown as number;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, initialPrepaid, onPrepaidChanged]);

  if (!open) return null;

  const handleBuy = async (tier: Tier): Promise<void> => {
    const r = await window.billing.startCheckout(tier);
    if (!r.ok) {
      setPhase({ kind: 'error', message: r.error ?? 'failed to start checkout' });
      return;
    }
    setPhase({ kind: 'waiting', tier, startedAt: Date.now(), testMode: !!r.test_mode });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base">Buy more pages</h3>

        {phase.kind === 'choose' && (
          <>
            <div className="grid grid-cols-3 gap-3">
              {CATALOGUE.map((entry) => {
                const selected = entry.tier === selectedTier;
                return (
                  <button
                    key={entry.tier}
                    type="button"
                    onClick={() => setSelectedTier(entry.tier)}
                    aria-pressed={selected}
                    className={
                      'relative flex flex-col items-start gap-2 w-full px-4 py-4 rounded-lg border-2 transition-colors cursor-pointer text-left ' +
                      (selected
                        ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                        : 'border-border bg-secondary hover:bg-secondary/80')
                    }
                  >
                    {entry.badge && (
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider bg-primary text-primary-foreground px-2.5 py-0.5 rounded-full shadow">
                        {entry.badge}
                      </span>
                    )}
                    <div className="font-medium capitalize">{entry.tier}</div>
                    <div className="text-2xl font-semibold">
                      {formatPrice(entry.price_cents)}
                    </div>
                    <div className="text-xs text-muted-foreground">{entry.perPage}</div>
                    <div className="text-xs text-muted-foreground">
                      <strong className="font-semibold text-foreground">
                        {entry.pages.toLocaleString()}
                      </strong>{' '}
                      pages
                    </div>
                    <div className="text-xs text-muted-foreground">{entry.note}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Checkout opens in your browser. Pages appear here automatically once
              Polar confirms the purchase.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBuy(selectedTier)}
                className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Buy {selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)} —{' '}
                {formatPrice(
                  CATALOGUE.find((e) => e.tier === selectedTier)!.price_cents,
                )}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'waiting' && (
          <>
            {phase.testMode && (
              <span className="self-start text-[10px] font-semibold uppercase tracking-wide bg-yellow-200 text-yellow-900 px-2 py-0.5 rounded">
                Test Mode
              </span>
            )}
            <p className="text-sm">Waiting for purchase to land…</p>
            <p className="text-xs text-muted-foreground">
              Complete checkout in the browser tab that just opened. We'll
              check every 5 seconds for up to 5 minutes.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Hide
              </button>
            </div>
          </>
        )}

        {phase.kind === 'success' && (
          <>
            <p className="text-sm">
              Purchase complete — {phase.pagesAdded.toLocaleString()} pages added.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </>
        )}

        {phase.kind === 'timeout' && (
          <>
            <p className="text-sm">
              Still processing — check your email for confirmation. Your
              balance will update automatically when the purchase lands.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p className="text-sm text-destructive">
              Couldn't start checkout: {phase.message}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPhase({ kind: 'choose' })}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
