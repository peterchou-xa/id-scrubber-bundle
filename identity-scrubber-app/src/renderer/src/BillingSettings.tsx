import { JSX, useEffect, useState } from 'react';

interface PrepaidView {
  usage: number;
  granted: number;
}

export function BillingSettings({
  open,
  onClose,
  prepaid,
  onOpenBuy,
}: {
  open: boolean;
  onClose: () => void;
  prepaid: PrepaidView | null | undefined;
  onOpenBuy: () => void;
}): JSX.Element | null {
  const [licenseKey, setLicenseKey] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setLicenseError(null);
    void (async () => {
      const r = await window.billing.getLicenseInfo();
      if (r.error) {
        setLicenseError(r.error);
        setLicenseKey(null);
      } else {
        setLicenseKey(r.license_key);
      }
    })();
  }, [open]);

  if (!open) return null;

  const remaining = prepaid ? Math.max(0, prepaid.granted - prepaid.usage) : 0;
  const purchased = prepaid?.granted ?? 0;

  const copyKey = async (): Promise<void> => {
    if (!licenseKey) return;
    await navigator.clipboard.writeText(licenseKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base">Billing</h3>

        <div className="text-sm flex flex-col gap-2 bg-secondary rounded-md p-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Prepaid balance</span>
            <span className="font-medium">{remaining.toLocaleString()} pages</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total purchased</span>
            <span>{purchased.toLocaleString()} pages</span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs text-muted-foreground">License key (support reference)</div>
          {licenseError ? (
            <div className="text-xs text-destructive">Couldn't load: {licenseError}</div>
          ) : licenseKey ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-secondary rounded px-2 py-1 break-all">
                {licenseKey}
              </code>
              <button
                type="button"
                onClick={() => void copyKey()}
                className="px-2 py-1 text-xs rounded-md bg-secondary border border-border hover:bg-secondary/80 cursor-pointer"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No purchases yet on this device.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium rounded-md hover:bg-secondary transition-colors cursor-pointer"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenBuy();
            }}
            className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
          >
            Buy more pages
          </button>
        </div>
      </div>
    </div>
  );
}
