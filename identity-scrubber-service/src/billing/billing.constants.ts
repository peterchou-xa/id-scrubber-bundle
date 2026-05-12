export const SKUS = {
  freeWeek1: 'free_week1',
  freeDaily: 'free_daily',
  prepaid: 'prepaid',
} as const;

export const TIER_PAGES: Record<string, number> = {
  starter: 100,
  pro: 500,
  power: 2000,
};

export const FREE_WEEK1_PAGES = 20;
export const FREE_DAILY_PAGES = 1;
export const PAGES_SANITY_CAP = 10_000;
