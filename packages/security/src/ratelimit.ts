import { NexusError } from '@nexus/shared';

export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

interface Bucket { count: number; resetAt: number }

/** Sliding-window token bucket, per key. In-memory is enough for a single API instance. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly opts: RateLimitOptions) {}

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + this.opts.windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.opts.max - 1, resetAt };
    }
    bucket.count += 1;
    if (bucket.count > this.opts.max) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }
    return { allowed: true, remaining: this.opts.max - bucket.count, resetAt: bucket.resetAt };
  }

  /** Throws a 429 NexusError when the key is over quota. */
  consume(key: string): void {
    const res = this.check(key);
    if (!res.allowed) {
      throw new NexusError('rate_limited', 'Too many requests, slow down', {
        details: { retryAfterMs: Math.max(0, res.resetAt - Date.now()) },
      });
    }
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}
