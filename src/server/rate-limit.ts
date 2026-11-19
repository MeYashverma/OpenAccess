/**
 * Small fixed-window rate limiters and an hourly egress budget.
 *
 * They live in process memory, which is the correct scope for a single-instance
 * deployment. Behind multiple instances, enforce limits at the edge
 * (Cloudflare / the platform's proxy) as well.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.max(windowMs, 60_000));
    this.sweeper.unref?.();
  }

  check(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    if (this.limit <= 0) return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    bucket.count++;
    return { allowed: true, remaining: this.limit - bucket.count, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size > 100_000) this.buckets.clear();
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}

export class HourlyBudget {
  private windowStart = Math.floor(Date.now() / 3_600_000);
  private used = 0;
  private sweeper: NodeJS.Timeout;

  constructor(private readonly limitBytes: number) {
    this.sweeper = setInterval(() => this.roll(), 60_000);
    this.sweeper.unref?.();
  }

  private roll(): void {
    const current = Math.floor(Date.now() / 3_600_000);
    if (current !== this.windowStart) {
      this.windowStart = current;
      this.used = 0;
    }
  }

  get exhausted(): boolean {
    if (this.limitBytes <= 0) return false;
    this.roll();
    return this.used >= this.limitBytes;
  }

  add(bytes: number): void {
    this.roll();
    this.used += bytes;
  }

  snapshot(): { used: number; limit: number } {
    this.roll();
    return { used: this.used, limit: this.limitBytes };
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
