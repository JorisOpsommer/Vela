// The cache page's data — what the on-disk market-data cache holds, how fresh it is, what
// it saved, and what the warmer is doing — plus the chart's first-paint timings and the
// admin's housekeeping actions. Accounts are never named: a symbol only says how many
// accounts watch it.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { activity } from '../market/background';
import { metrics } from '../market/metrics';
import { MAX_BARS_PER_SERIES, RETENTION_MS, type SeriesRow } from '../market/cache-store';
import { collectTargets } from '../market/warm-targets';
import { localDate, zonedWallTime } from '../market/timeframes';

const TIMING_KINDS = new Set(['complete', 'cached', 'cold', 'memory', 'quotes-cached', 'quotes-cold']);
/** A series fetched within this long counts as fresh on the freshness map. */
const FRESH_MS = 2 * 3_600_000;
const ACTIVITY_BUCKET_MIN = 10;
const DAY_MS = 86_400_000;
const NY = 'America/New_York';

function percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function registerCacheRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { cached, warmer, db, market } = ctx;
    const store = cached.store;

    app.post('/api/cache/timing', async (req, reply) => {
        const b = (req.body ?? {}) as { kind?: unknown; ms?: unknown };
        if (typeof b.kind !== 'string' || !TIMING_KINDS.has(b.kind) || typeof b.ms !== 'number' || !Number.isFinite(b.ms) || b.ms < 0 || b.ms > 120_000) {
            return reply.code(400).send({ error: 'Bad timing.' });
        }
        store.recordTiming(b.kind, Math.round(b.ms));
        return { ok: true };
    });

    app.get('/api/cache/overview', async (req) => {
        const now = Date.now();
        const series = store.allSeries();
        const plan = collectTargets(db, market.catalog, now);

        // Freshness: every target and every stored series, one cell per symbol × timeframe × session.
        const cells = new Map<string, { symbol: string; tf: string; session: string; status: 'complete' | 'fresh' | 'stale' | 'missing'; fetchedAt: number | null; bars: number; source: string | null; target: boolean }>();
        const complete = await Promise.all(series.map((s) => completeOf(s, now)));
        series.forEach((s, i) => {
            cells.set(s.key, { symbol: s.symbol, tf: s.tf, session: s.session, status: complete[i] ? 'complete' : now - s.fetchedAt < FRESH_MS ? 'fresh' : 'stale', fetchedAt: s.fetchedAt, bars: s.bars, source: s.source, target: false });
        });
        for (const t of plan.targets) {
            const key = `${t.symbol}|${t.tf}|${t.session}`;
            const c = cells.get(key);
            if (c) c.target = true;
            else cells.set(key, { symbol: t.symbol, tf: t.tf, session: t.session, status: 'missing', fetchedAt: null, bars: 0, source: null, target: true });
        }

        const byTf = new Map<string, { series: number; bars: number }>();
        for (const s of series) {
            const v = byTf.get(s.tf) ?? { series: 0, bars: 0 };
            v.series += 1;
            v.bars += s.bars;
            byTf.set(s.tf, v);
        }

        const timings = store.timings(now - DAY_MS);
        const timingSummary = [...TIMING_KINDS].map((kind) => {
            const ms = timings.filter((t) => t.kind === kind).map((t) => t.ms).sort((a, b) => a - b);
            return { kind, count: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95) };
        });
        // Hourly medians of chart first paints, cached against cold.
        const hours: Array<{ t: number; cached: number | null; cold: number | null }> = [];
        for (let h = 23; h >= 0; h--) {
            const from = Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000;
            const inHour = timings.filter((t) => t.at >= from && t.at < from + 3_600_000);
            const med = (kinds: string[]) => percentile(inHour.filter((t) => kinds.includes(t.kind)).map((t) => t.ms).sort((a, b) => a - b), 50);
            hours.push({ t: from, cached: med(['cached', 'complete']), cold: med(['cold']) });
        }

        const minutes = activity.series(24 * 60);
        const buckets: Array<{ t: number; user: number; background: number }> = [];
        for (let i = 0; i < minutes.length; i += ACTIVITY_BUCKET_MIN) {
            const slice = minutes.slice(i, i + ACTIVITY_BUCKET_MIN);
            buckets.push({ t: slice[0]!.t, user: slice.reduce((a, m) => a + m.user, 0), background: slice.reduce((a, m) => a + m.background, 0) });
        }

        const quotes = store.quoteAges();
        const snap = metrics.snapshot();

        return {
            now,
            startedAt: snap.startedAt,
            isAdmin: req.session!.user.role === 'admin',
            storage: { sizeBytes: store.sizeBytes(), retentionDays: RETENTION_MS / DAY_MS, maxBarsPerSeries: MAX_BARS_PER_SERIES, ...store.totals() },
            byTimeframe: [...byTf.entries()].map(([tf, v]) => ({ tf, ...v })).sort((a, b) => b.bars - a.bars),
            counters: cached.counters,
            bySource: [...cached.bySource.entries()].map(([source, v]) => ({ source, ...v })),
            freshness: [...cells.values()].map((c) => ({ ...c, watchers: plan.watched.get(c.symbol) ?? 0 })),
            targets: { pairs: plan.targets.length, symbols: plan.watched.size },
            quotes: { count: quotes.length, newest: quotes.length ? Math.max(...quotes.map((q) => q.fetchedAt)) : null, oldest: quotes.length ? Math.min(...quotes.map((q) => q.fetchedAt)) : null },
            warmer: warmer ? { ...warmer.status(), upcoming: await warmer.upcoming(now).catch(() => []) } : null,
            runs: store.runs(15),
            activity: buckets,
            sessions: await sessionWindows(now - DAY_MS, now),
            timings: { summary: timingSummary, hours },
            events: store.events(30),
            budgets: snap.bridges.filter((b) => b.budget).map((b) => ({ id: b.id, headroom: metrics.headroom(b.id), perMinute: b.budget!.perMinute })),
        };
    });

    app.post('/api/admin/cache/warm', async () => {
        if (!warmer) return { ok: false };
        warmer.warmNow();
        return { ok: true };
    });

    app.post('/api/admin/cache/purge', async () => ({ ok: true, removed: store.purge() }));

    app.post('/api/admin/cache/clear', async () => {
        store.clear();
        return { ok: true };
    });

    async function completeOf(s: SeriesRow, now: number): Promise<boolean> {
        const entry = market.resolve(s.symbol);
        return entry ? cached.isComplete(entry, s, now).catch(() => false) : false;
    }

    /** US regular and extended session windows over the range, for the activity chart's bands. */
    async function sessionWindows(from: number, to: number): Promise<{ regular: Array<[number, number]>; extended: Array<[number, number]> }> {
        const regular: Array<[number, number]> = [];
        const extended: Array<[number, number]> = [];
        const cal = await market.bridges.alpaca?.calendar(from - DAY_MS, to + DAY_MS).catch(() => null);
        for (let t = from - DAY_MS; t <= to + DAY_MS; t += DAY_MS) {
            const date = localDate(NY, t);
            const [y, m, d] = date.split('-').map(Number) as [number, number, number];
            let day: { open: number; close: number; sessionOpen: number; sessionClose: number } | undefined;
            if (cal) day = cal.get(date);
            else if (![0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) {
                const at = (h: number) => zonedWallTime(NY, y, m - 1, d, h * 3_600_000);
                day = { open: at(9.5), close: at(16), sessionOpen: at(4), sessionClose: at(20) };
            }
            if (!day || regular.some((w) => w[0] === day!.open)) continue;
            if (day.close > from && day.open < to) regular.push([day.open, day.close]);
            if (day.sessionClose > from && day.sessionOpen < to) extended.push([day.sessionOpen, day.sessionClose]);
        }
        return { regular, extended };
    }
}
