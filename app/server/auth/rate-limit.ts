// In-memory failure counters for the login endpoint. One process serves the app, so
// memory is the right store; a restart resets counters, which only helps the owner.

interface Bucket {
    failures: number;
    windowStart: number;
    lockedUntil: number;
}

export interface LimiterOptions {
    /** Failures allowed inside `windowMs` before the key locks. */
    maxFailures: number;
    windowMs: number;
    /** First lockout; doubles on each further lockout inside the window, capped at `maxLockMs`. */
    lockMs: number;
    maxLockMs: number;
}

export class FailureLimiter {
    private readonly buckets = new Map<string, Bucket & { lockouts: number }>();

    constructor(private readonly opts: LimiterOptions, private readonly now: () => number = Date.now) {}

    /** Milliseconds until `key` may try again; 0 when allowed. */
    retryAfter(key: string): number {
        const b = this.buckets.get(key);
        if (!b) return 0;
        return Math.max(0, b.lockedUntil - this.now());
    }

    fail(key: string): void {
        const t = this.now();
        let b = this.buckets.get(key);
        if (!b || t - b.windowStart > this.opts.windowMs) {
            b = { failures: 0, windowStart: t, lockedUntil: 0, lockouts: b && t - b.windowStart <= this.opts.windowMs * 4 ? b.lockouts : 0 };
            this.buckets.set(key, b);
        }
        b.failures += 1;
        if (b.failures >= this.opts.maxFailures) {
            const lock = Math.min(this.opts.lockMs * 2 ** b.lockouts, this.opts.maxLockMs);
            b.lockedUntil = t + lock;
            b.lockouts += 1;
            b.failures = 0;
            b.windowStart = t;
        }
        this.sweep(t);
    }

    succeed(key: string): void {
        this.buckets.delete(key);
    }

    private sweep(t: number): void {
        if (this.buckets.size < 10_000) return;
        for (const [k, b] of this.buckets) {
            if (b.lockedUntil < t && t - b.windowStart > this.opts.windowMs) this.buckets.delete(k);
        }
    }
}

/** A fixed-window request counter (per-user API budget, not auth). */
export class WindowCounter {
    private readonly counts = new Map<string, { n: number; start: number }>();

    constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

    hit(key: string): boolean {
        const t = this.now();
        const c = this.counts.get(key);
        if (!c || t - c.start >= this.windowMs) {
            this.counts.set(key, { n: 1, start: t });
            if (this.counts.size > 10_000) this.counts.clear();
            return true;
        }
        c.n += 1;
        return c.n <= this.max;
    }
}
