/** Classic token bucket: `ratePerSec` sustained, `burst` maximum. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private ratePerSec: number,
    private burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now(), cost = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Fixed-window counter keyed by an arbitrary string (IP address, client id). Bounded in size. */
export class WindowLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private maxKeys = 10_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    let entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (!entry && this.hits.size >= this.maxKeys) this.prune(now);
      entry = { count: 0, windowStart: now };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** True if `key` has already used up its allowance in the current window (does not count a hit). */
  exceeded(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    return !!entry && now - entry.windowStart < this.windowMs && entry.count >= this.max;
  }

  prune(now = Date.now()): void {
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

/** Insertion-ordered bounded set used for message de-duplication. */
export class BoundedSet {
  private items = new Set<string>();
  constructor(private capacity: number) {}
  has(key: string): boolean {
    return this.items.has(key);
  }
  add(key: string): void {
    this.items.add(key);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
  get size(): number {
    return this.items.size;
  }
}
