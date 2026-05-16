import { Injectable } from '@nestjs/common';

export interface RateLimiter {
  tryConsume(bucketKey: string, capacity: number, refillPerSec: number): boolean;
}

interface Bucket {
  tokens: number;
  lastRefilledMs: number;
}

// In-memory token bucket. Single Nest instance today; failing open across
// restarts is the safe direction for an abuse-mitigation limiter (per the
// design doc). When the service goes multi-instance, swap to a Postgres-backed
// implementation behind this same interface — atomic
// `INSERT ... ON CONFLICT UPDATE` on a `rate_limits` table.
@Injectable()
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  tryConsume(bucketKey: string, capacity: number, refillPerSec: number): boolean {
    const now = Date.now();
    let b = this.buckets.get(bucketKey);
    if (!b) {
      b = { tokens: capacity, lastRefilledMs: now };
      this.buckets.set(bucketKey, b);
    }
    const elapsedSec = (now - b.lastRefilledMs) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.lastRefilledMs = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }
}
