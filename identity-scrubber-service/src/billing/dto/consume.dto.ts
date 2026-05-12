export interface ConsumeDto {
  machine_id: string;
  device_id: string;
  pages: number;
}

export interface BalanceView {
  usage: number;
  granted: number;
  resets_at?: string;
  expires_at?: string;
}

export interface ConsumeResponse {
  allow: boolean;
  reason?: 'invalid_device' | 'insufficient_balance';
  consumed?: { free_daily: number; free_week1: number; prepaid: number };
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
}

export interface BalanceQueryDto {
  machine_id: string;
  device_id: string;
}

export interface BalanceResponse {
  ok: boolean;
  reason?: 'invalid_device';
  free_daily?: BalanceView;
  free_week1?: BalanceView;
  prepaid?: { usage: number; granted: number } | null;
}
