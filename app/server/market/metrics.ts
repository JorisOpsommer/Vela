// Operational metrics for the provider-stats page: every upstream call (latency,
// outcome, rate-limit headers), cache effectiveness, and request-budget pressure.
// In memory, since process start — a restart begins a fresh window.
import { activity, isBackground } from './background';

export type MetricBridge = 'alpaca' | 'finnhub' | 'yahoo' | 'energycharts' | 'coinbase';

export const METRIC_BRIDGES: MetricBridge[] = ['alpaca', 'finnhub', 'yahoo', 'energycharts', 'coinbase'];

export interface CallRecord {
    bridge: MetricBridge;
    /** Endpoint label (`bars:sip`, `quote`, …) — never a URL with credentials. */
    tag: string;
    ms: number;
    /** HTTP status, or 0 for a network error/timeout. */
    status: number;
    error?: string;
    /** Upstream-reported budget (rate-limit headers), when sent. */
    remaining?: number;
    limit?: number;
}

interface MinuteBucket {
    minute: number;
    calls: number;
    errors: number;
    throttled: number;
    latencies: number[];
}

interface BridgeState {
    total: number;
    errors: number;
    throttled: number;
    minutes: MinuteBucket[];
    recent: number[];
    tags: Map<string, { calls: number; errors: number; ms: number }>;
    upstream: { remaining: number; limit: number; at: number } | null;
    lastOkAt: number | null;
    lastErrorAt: number | null;
}

interface CacheCounters {
    hits: number;
    misses: number;
    coalesced: number;
}

interface BudgetProbe {
    perMinute: number;
    readonly capacity: number;
    available(): number;
    waiting(): number;
    waits: number;
    rejected: number;
}

const HISTORY_MINUTES = 60;
const RECENT_SAMPLES = 400;
const ERROR_LOG = 40;

function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i]!;
}

export class Metrics {
    readonly startedAt = Date.now();
    private bridges = new Map<MetricBridge, BridgeState>();
    private caches = new Map<string, CacheCounters>();
    private budgets = new Map<string, BudgetProbe>();
    private errorLog: Array<{ at: number; bridge: MetricBridge; tag: string; status: number; message: string }> = [];

    constructor(private readonly now: () => number = Date.now) {}

    private state(b: MetricBridge): BridgeState {
        let s = this.bridges.get(b);
        if (!s) {
            s = { total: 0, errors: 0, throttled: 0, minutes: [], recent: [], tags: new Map(), upstream: null, lastOkAt: null, lastErrorAt: null };
            this.bridges.set(b, s);
        }
        return s;
    }

    record(r: CallRecord): void {
        activity.record(isBackground());
        const t = this.now();
        const s = this.state(r.bridge);
        const ok = r.status >= 200 && r.status < 400;
        const throttled = r.status === 429;
        s.total += 1;
        if (!ok) s.errors += 1;
        if (throttled) s.throttled += 1;
        if (ok) s.lastOkAt = t;
        else s.lastErrorAt = t;

        const minute = Math.floor(t / 60_000);
        let m = s.minutes[s.minutes.length - 1];
        if (!m || m.minute !== minute) {
            m = { minute, calls: 0, errors: 0, throttled: 0, latencies: [] };
            s.minutes.push(m);
            while (s.minutes.length > 0 && s.minutes[0]!.minute <= minute - HISTORY_MINUTES) s.minutes.shift();
        }
        m.calls += 1;
        if (!ok) m.errors += 1;
        if (throttled) m.throttled += 1;
        if (m.latencies.length < 500) m.latencies.push(r.ms);

        s.recent.push(r.ms);
        if (s.recent.length > RECENT_SAMPLES) s.recent.shift();

        const tag = s.tags.get(r.tag) ?? { calls: 0, errors: 0, ms: 0 };
        tag.calls += 1;
        tag.ms += r.ms;
        if (!ok) tag.errors += 1;
        s.tags.set(r.tag, tag);

        if (r.remaining != null && r.limit != null && Number.isFinite(r.remaining) && Number.isFinite(r.limit)) {
            s.upstream = { remaining: r.remaining, limit: r.limit, at: t };
        }
        if (!ok) {
            this.errorLog.push({ at: t, bridge: r.bridge, tag: r.tag, status: r.status, message: (r.error ?? `HTTP ${r.status}`).slice(0, 160) });
            if (this.errorLog.length > ERROR_LOG) this.errorLog.shift();
        }
    }

    cache(label: string): CacheCounters {
        let c = this.caches.get(label);
        if (!c) {
            c = { hits: 0, misses: 0, coalesced: 0 };
            this.caches.set(label, c);
        }
        return c;
    }

    registerBudget(label: string, probe: BudgetProbe): void {
        this.budgets.set(label, probe);
    }

    /** Share of a bridge's request bucket that is free right now (1 when it has none). */
    headroom(label: string): number {
        const b = this.budgets.get(label);
        return b ? b.available() / Math.max(1, b.capacity) : 1;
    }

    /** Wraps a logical upstream call that does not go through `fetchJson`. */
    async time<T>(bridge: MetricBridge, tag: string, fn: () => Promise<T>): Promise<T> {
        const t0 = performance.now();
        try {
            const v = await fn();
            this.record({ bridge, tag, ms: performance.now() - t0, status: 200 });
            return v;
        } catch (err) {
            const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 0;
            this.record({ bridge, tag, ms: performance.now() - t0, status: status || 0, error: (err as Error).message });
            throw err;
        }
    }

    snapshot() {
        const t = this.now();
        const nowMinute = Math.floor(t / 60_000);
        const bridges = METRIC_BRIDGES.map((id) => {
            const s = this.state(id);
            const recentSorted = [...s.recent].sort((a, b) => a - b);
            const series: Array<{ t: number; calls: number; errors: number; throttled: number; p50: number | null; p95: number | null }> = [];
            for (let i = HISTORY_MINUTES - 1; i >= 0; i--) {
                const minute = nowMinute - i;
                const m = s.minutes.find((x) => x.minute === minute);
                const lat = m ? [...m.latencies].sort((a, b) => a - b) : [];
                series.push({ t: minute * 60_000, calls: m?.calls ?? 0, errors: m?.errors ?? 0, throttled: m?.throttled ?? 0, p50: percentile(lat, 50), p95: percentile(lat, 95) });
            }
            const last = (mins: number) => series.slice(-mins).reduce((a, x) => a + x.calls, 0);
            // Calls in the trailing 60 s, prorated across the current and previous minute.
            const frac = (t % 60_000) / 60_000;
            const cur = series[series.length - 1]!.calls;
            const prev = series[series.length - 2]?.calls ?? 0;
            const cache = this.cache(id);
            const budget = this.budgets.get(id);
            return {
                id,
                total: s.total,
                errors: s.errors,
                throttled: s.throttled,
                callsLastMinute: Math.round(cur + prev * (1 - frac)),
                calls5m: last(5),
                calls60m: last(60),
                latency: { p50: percentile(recentSorted, 50), p95: percentile(recentSorted, 95), max: recentSorted[recentSorted.length - 1] ?? null, samples: recentSorted.length },
                upstream: s.upstream && t - s.upstream.at < 5 * 60_000 ? s.upstream : null,
                lastOkAt: s.lastOkAt,
                lastErrorAt: s.lastErrorAt,
                cache: { ...cache, hitRate: cache.hits + cache.misses + cache.coalesced > 0 ? (cache.hits + cache.coalesced) / (cache.hits + cache.misses + cache.coalesced) : null },
                budget: budget ? { perMinute: budget.perMinute, available: Math.floor(budget.available()), waiting: budget.waiting(), waits: budget.waits, rejected: budget.rejected } : null,
                endpoints: [...s.tags.entries()]
                    .map(([tag, v]) => ({ tag, calls: v.calls, errors: v.errors, avgMs: v.calls ? v.ms / v.calls : 0 }))
                    .sort((a, b) => b.calls - a.calls)
                    .slice(0, 8),
                series,
            };
        });
        return { startedAt: this.startedAt, now: t, bridges, errors: [...this.errorLog].reverse() };
    }

    reset(): void {
        this.bridges = new Map();
        this.caches = new Map();
        this.budgets = new Map();
        this.errorLog = [];
    }
}

export const metrics = new Metrics();
