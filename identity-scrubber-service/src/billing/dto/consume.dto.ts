export interface OfflineLeaseReport {
  issued_at: string;
  used: number;
}

export interface ConsumeDto {
  machine_id: string;
  device_id: string;
  pages: number;
  offline_lease?: OfflineLeaseReport;
}

export interface BalanceView {
  usage: number;
  granted: number;
  resets_at?: string;
  expires_at?: string;
}

export interface Lease {
  account_id: string;
  issued_at: string;
  expires_at: string;
  ceiling: number;
}

// Set when the server charged the un-drained portion of a lease's ceiling
// because the client called /balance or /consume without an offline_lease
// report. The renderer uses lease_issued_at to dedupe notices.
export interface OfflinePenalty {
  charged: number;
  lease_issued_at: string;
}

export interface ConsumeResponse {
  allow: boolean;
  reason?: 'invalid_device' | 'insufficient_balance';
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  lease?: Lease;
  offline_penalty?: OfflinePenalty;
}

export interface BalanceQueryDto {
  machine_id: string;
  device_id: string;
  offline_lease?: OfflineLeaseReport;
  include_licenses?: boolean;
}

export interface LicenseView {
  id: number;
  sku: string;
  tier: string | null;
  quota_total: number;
  amount_cents: number | null;
  ls_order_id: string | null;
  created_at: string;
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device';
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  lease?: Lease;
  licenses?: LicenseView[];
  offline_penalty?: OfflinePenalty;
}
