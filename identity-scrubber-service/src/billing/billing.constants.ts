export const SKUS = {
  freeWeek1: 'free_week1',
  freeDaily: 'free_daily',
  prepaid: 'prepaid',
} as const;

export const TIER_PAGES: Record<string, number> = {
  starter: 100,
  pro: 500,
  max: 2000,
};

export const TIER_PRICE_CENTS: Record<string, number> = {
  starter: 900,
  pro: 1900,
  max: 4900,
};

export type Tier = 'starter' | 'pro' | 'max';

export const FREE_WEEK1_PAGES = 20;
export const FREE_DAILY_PAGES = 1;
export const PAGES_SANITY_CAP = 10_000;

export const OFFLINE_CAP = 10;
export const LEASE_TTL_MINUTES = 24 * 60;
// Re-mint policy: when the active lease has passed half its TTL. Ties the
// issuance rate to the TTL so we don't need a separate rate-limit constant;
// abuse window per cycle is bounded by ceiling / (TTL / 2).
