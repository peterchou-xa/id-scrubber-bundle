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

export interface ConsumeResponse {
  allow: boolean;
  reason?: 'invalid_device' | 'insufficient_balance';
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  lease?: Lease;
}

export interface BalanceQueryDto {
  machine_id: string;
  device_id: string;
  offline_lease?: OfflineLeaseReport;
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device';
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
  lease?: Lease;
}
