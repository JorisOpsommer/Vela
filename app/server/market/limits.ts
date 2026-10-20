// Upstream politeness: a per-bridge token bucket (requests/minute), a TTL cache that
// also coalesces identical in-flight requests, and a fetch wrapper with timeout and 429
// backoff. Many browsers looking at the same symbol cost the upstream one request.
import { UpstreamError } from './types';
import { metrics, type MetricBridge } from './metrics';

export class TokenBucket {
    private tokens: number;
    private last: number;
    private readonly queue: Array<() => void> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Takes that had to queue, and takes refused because the queue was too long. */
    waits = 0;
    rejected = 0;

    /** `perMinute` sustained; `burst` the bucket size. `label` reports it on the stats page. */
    constructor(readonly perMinute: number, private readonly burst: number = Math.max(1, Math.ceil(perMinute / 6)), label?: string) {
        this.tokens = this.burst;
        this.last = Date.now();
        if (label) metrics.registerBudget(label, this);
    }

    waiting(): number {
        return this.queue.length;
    }

    private refill(): void {
        const t = Date.now();
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
        this.last = t;
    }

    /** Tokens currently available (after refill). */
    available(): number {
        this.refill();
        return this.tokens;
    }

    /** Resolve when a token is granted. Rejects when the wait would exceed `maxWaitMs`. */
    take(maxWaitMs = 15_000): Promise<void> {
        this.refill();
        if (this.queue.length === 0 && this.tokens >= 1) {
            this.tokens -= 1;
            return Promise.resolve();
        }
        const waitMs = ((this.queue.length + 1 - this.tokens) / this.perMinute) * 60_000;
        if (waitMs > maxWaitMs) {
            this.rejected += 1;
            return Promise.reject(new UpstreamError('rate budget exhausted', 429, Math.ceil(waitMs - maxWaitMs)));
        }
        this.waits += 1;
        return new Promise((resolve) => {
            this.queue.push(resolve);
            this.pump();
        });
    }

    private pump(): void {
        if (this.timer) return;
        this.refill();
        while (this.queue.length > 0 && this.tokens >= 1) {
            this.tokens -= 1;
            this.queue.shift()!();
        }
        if (this.queue.length > 0) {
            const ms = Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000);
            this.timer = setTimeout(() => {
                this.timer = null;
                this.pump();
            }, Math.max(ms, 5));
        }
    }
}

interface CacheEntry<T> {
    value: T;
    expires: number;
}

export class TtlCache<T> {
    private readonly entries = new Map<string, CacheEntry<T>>();
    private readonly inflight = new Map<string, Promise<T>>();
    private readonly counters: { hits: number; misses: number; coalesced: number } | null;

    /** `label` attributes hit/miss counts to a bridge on the stats page. */
    constructor(private readonly maxEntries = 2_000, label?: string) {
        this.counters = label ? metrics.cache(label) : null;
    }

    get(key: string): T | undefined {
        const e = this.entries.get(key);
        if (!e) return undefined;
        if (e.expires < Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return e.value;
    }

    /** The last value even if expired — the fallback when the upstream is down. */
    stale(key: string): T | undefined {
        return this.entries.get(key)?.value;
    }

    set(key: string, value: T, ttlMs: number): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: Date.now() + ttlMs });
        if (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
    }

    /** Cached value, else run `load` once for all concurrent callers. `ttl` may depend on the value. */
    async wrap(key: string, ttl: number | ((v: T) => number), load: () => Promise<T>): Promise<T> {
        const hit = this.get(key);
        if (hit !== undefined) {
            if (this.counters) this.counters.hits += 1;
            return hit;
        }
        const pending = this.inflight.get(key);
        if (pending) {
            if (this.counters) this.counters.coalesced += 1;
            return pending;
        }
        if (this.counters) this.counters.misses += 1;
        const p = load()
            .then((v) => {
                this.set(key, v, typeof ttl === 'function' ? ttl(v) : ttl);
                return v;
            })
            .finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }
}

export interface FetchOptions {
    headers?: Record<string, string>;
    timeoutMs?: number;
    retries?: number;
    /** Attributes the call on the stats page. */
    bridge?: MetricBridge;
    /** Endpoint label for the stats page (the URL is never recorded — it may hold a key). */
    tag?: string;
}

function headerNum(res: Response, name: string): number | undefined {
    const v = res.headers.get(name);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    const tag = opts.tag ?? 'request';
    for (let attempt = 0; ; attempt++) {
        const t0 = performance.now();
        const res = await fetch(url, { headers: { Accept: 'application/json', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) }).catch((err: unknown) => {
            if (opts.bridge) metrics.record({ bridge: opts.bridge, tag, ms: performance.now() - t0, status: 0, error: `network: ${(err as Error).message}` });
            throw new UpstreamError(`network error: ${(err as Error).message}`);
        });
        if (opts.bridge) {
            metrics.record({
                bridge: opts.bridge,
                tag,
                ms: performance.now() - t0,
                status: res.status,
                remaining: headerNum(res, 'x-ratelimit-remaining'),
                limit: headerNum(res, 'x-ratelimit-limit'),
                ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
            });
        }
        if (res.status === 429 && attempt < retries) {
            const ra = Number(res.headers.get('retry-after'));
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 800 * 2 ** attempt);
            continue;
        }
        if (res.status >= 500 && attempt < retries) {
            await sleep(500 * 2 ** attempt);
            continue;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const ra = Number(res.headers.get('retry-after'));
            throw new UpstreamError(`HTTP ${res.status}: ${body.slice(0, 200)}`, res.status, res.status === 429 && Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        }
        return (await res.json()) as T;
    }
}
