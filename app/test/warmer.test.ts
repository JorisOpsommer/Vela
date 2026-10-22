// The cache warmer works only while the providers are quiet, steps aside the moment a
// user reaches one, counts its own calls apart from the users', and stays off the source
// whose spare budget feeds the real-time pre/post prices.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDbAt } from '../server/db';
import { CachedMarket } from '../server/market/cached-market';
import { CacheStore, seriesKey } from '../server/market/cache-store';
import { Catalog } from '../server/market/catalog';
import { MarketService } from '../server/market/service';
import { CacheWarmer } from '../server/market/warmer';
import { activity, runAsUpkeep, runInBackground } from '../server/market/background';
import { BackgroundYield, TokenBucket, TtlCache, setBackgroundGate } from '../server/market/limits';
import { collectTargets } from '../server/market/warm-targets';
import type { LiveHub } from '../server/market/live';
import type { BarRequest, Bridge, OHLCV } from '../server/market/types';

const MIN = 60_000;
const OPEN = Date.UTC(2026, 9, 21, 15, 0); // Wed 11:00 New York — regular hours
const CLOSED = Date.UTC(2026, 9, 21, 22, 0); // Wed 18:00 New York

afterEach(() => {
    vi.useRealTimers();
    setBackgroundGate(null);
});

function world(opts: { onCall?: (n: number) => void } = {}) {
    const calls: string[] = [];
    const bridge: Bridge = {
        id: 'yahoo',
        pollMs: 60_000,
        supports: () => true,
        async getBars(ticker: string, _tf, req: BarRequest): Promise<OHLCV[]> {
            calls.push(ticker);
            opts.onCall?.(calls.length);
            // Every bar call counts like a real upstream call would.
            const { metrics } = await import('../server/market/metrics');
            metrics.record({ bridge: 'yahoo', tag: 'bars', ms: 1, status: 200 });
            const now = Date.now();
            const n = req.limit ?? 100;
            return Array.from({ length: n }, (_, i) => ({ time: now - (n - i) * MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
        },
    };
    const catalog = new Catalog(
        {
            groups: [{ name: 'Default', symbols: ['IDX'] }],
            instruments: {
                IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                ALT: { name: 'Alt', class: 'index', prefix: 'INDEX', yahoo: 'ALT', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
            },
        },
        { alpaca: false, finnhub: false },
    );
    const market = new MarketService(catalog, { yahoo: bridge });
    const store = new CacheStore(':memory:');
    const cached = new CachedMarket(market, store);
    const db = openDbAt(':memory:');
    db.prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES ('a', 'x', 'user', 0, 0)").run();
    db.prepare("INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (1, 'watchlist', ?, ?)").run(JSON.stringify({ version: 1, groups: [{ name: 'Mine', symbols: ['IDX', 'ALT'] }] }), OPEN);
    db.prepare("INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (1, 'workspace', ?, 0)").run(JSON.stringify({ version: 1, charts: [{ symbol: 'INDEX:IDX', timeframe: '5', bars: 300 }] }));
    let topics = 0;
    const hub = { stats: () => ({ topics, listeners: topics }) } as unknown as LiveHub;
    const warmer = new CacheWarmer(cached, db, hub, { quietMs: 3 * MIN, stepGapMs: 0, tickMs: 60_000 });
    return { calls, store, cached, db, warmer, setStreams: (n: number) => (topics = n) };
}

describe('collectTargets', () => {
    it('warms the layout chart first, then the watchlist at 4h and Daily', () => {
        const { db, cached } = world();
        const plan = collectTargets(db, cached.market.catalog, OPEN);
        expect(plan.targets[0]).toMatchObject({ symbol: 'IDX', tf: '5', limit: 300, layout: true });
        expect(plan.targets.map((t) => `${t.symbol}|${t.tf}`).sort()).toEqual(['ALT|240', 'ALT|D', 'IDX|240', 'IDX|5', 'IDX|D']);
        expect([...plan.watched.keys()].sort()).toEqual(['ALT', 'IDX']);
    });

    it('adds the most active symbols at 15m and 1h: most time on screen, then most opens', () => {
        const { db, cached } = world();
        const ev = db.prepare('INSERT INTO analytics_events (user_id, ts, kind, value, extra, n) VALUES (1, ?, ?, ?, ?, ?)');
        ev.run(OPEN, 'open', 'IDX', '5', 1);
        ev.run(OPEN, 'watch', 'ALT', 'D', 30);
        ev.run(OPEN, 'watch', 'NOT$A$SYMBOL', 'D', 99); // not a symbol the catalog resolves
        ev.run(OPEN - 20 * 86_400_000, 'watch', 'IDX', 'D', 500); // outside the window
        const plan = collectTargets(db, cached.market.catalog, OPEN);
        expect(plan.accounts[0]!.top).toEqual([
            { symbol: 'ALT', minutes: 30, opens: 0 },
            { symbol: 'IDX', minutes: 0, opens: 1 },
        ]);
        expect(plan.targets.map((t) => `${t.symbol}|${t.tf}`).filter((k) => /\|(15|60)$/.test(k)).sort()).toEqual(['ALT|15', 'ALT|60', 'IDX|15', 'IDX|60']);
    });

    it('skips accounts not used in the last two weeks', () => {
        const { db, cached } = world();
        expect(collectTargets(db, cached.market.catalog, OPEN + 15 * 86_400_000).targets).toHaveLength(0);
        db.prepare("INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, last_seen) VALUES ('s', 1, 'c', 0, 0, ?)").run(OPEN + 10 * 86_400_000);
        expect(collectTargets(db, cached.market.catalog, OPEN + 15 * 86_400_000).targets).toHaveLength(5);
    });
});

describe('CacheWarmer', () => {
    it('waits for quiet providers, then fills the cache with calls counted as its own', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPEN);
        const { calls, store, warmer } = world();
        activity.record('user'); // a user just reached a provider
        vi.setSystemTime(OPEN + MIN);
        await warmer.tick();
        expect(warmer.state).toBe('waiting');
        expect(calls).toHaveLength(0);

        vi.setSystemTime(OPEN + 4 * MIN);
        const userBefore = activity.lastUserCall();
        await warmer.tick();
        expect(calls.length).toBeGreaterThan(0);
        expect(store.series(seriesKey('IDX', '5', 'all'))?.bars).toBe(300);
        expect(store.series(seriesKey('ALT', '240', 'all'))).toBeDefined();
        expect(store.series(seriesKey('ALT', 'D', 'all'))).toBeDefined();
        // Its calls did not look like user activity to its own gate.
        expect(activity.lastUserCall()).toBe(userBefore);
        expect(activity.series(1)[0]!.background).toBeGreaterThan(0);
        expect(store.runs()[0]).toMatchObject({ status: 'done' });
    });

    it('steps aside before its next request when a user reaches a provider', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPEN);
        // The first warm call is followed by a user's call.
        const { calls, warmer, store } = world({ onCall: (n) => n === 1 && activity.record('user') });
        vi.setSystemTime(OPEN + 10 * MIN);
        await warmer.tick();
        expect(calls).toHaveLength(1);
        expect(warmer.state).toBe('waiting');
        expect(store.runs()[0]).toMatchObject({ status: 'paused' });
    });

    it('keeps warming while screens sit open at idle', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPEN);
        const { calls, warmer, setStreams, store } = world();
        setStreams(2);
        vi.setSystemTime(OPEN + 20 * MIN);
        // Open charts polling and watchlists refreshing: provider use, but nobody charting.
        activity.record('upkeep');
        await warmer.tick();
        expect(calls.length).toBeGreaterThan(0);
        expect(store.runs()[0]).toMatchObject({ status: 'done' });
        expect(warmer.status().openCharts).toBe(2);
    });

    it('stays off the real-time extended-hours source outside regular hours', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(CLOSED);
        const { calls, warmer, store } = world();
        vi.setSystemTime(CLOSED + 10 * MIN);
        for (let i = 0; i < 5; i++) await warmer.tick(); // one due pass per round
        expect(calls).toHaveLength(0);
        const close = store.runs().find((r) => r.kind === 'close');
        // All five chart targets skipped; only the (empty-handed) quote step ran.
        expect(close).toMatchObject({ status: 'done', skipped: 5, failed: 0 });
    });
});

describe('background share of a provider', () => {
    const grantsWithin = async (bucket: TokenBucket, ms: number): Promise<number> => {
        let n = 0;
        const run = runInBackground(async () => {
            for (;;) {
                await bucket.take();
                n += 1;
            }
        }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, ms));
        setBackgroundGate(() => false); // ends the loop
        await run;
        return n;
    };

    it('leaves at least half of the bucket to users', async () => {
        const bucket = new TokenBucket(600, 10);
        expect(await grantsWithin(bucket, 120)).toBe(5);
        // A user still finds the other half at once.
        await bucket.take(0);
        expect(bucket.usedLastMinute()).toBe(6);
    });

    it('keeps the use of the last minute, by everyone, under half the rate', async () => {
        const bucket = new TokenBucket(6, 30);
        expect(await grantsWithin(bucket, 120)).toBe(3);
    });

    it('gives way at the next request the moment someone starts charting', async () => {
        const bucket = new TokenBucket(600, 10);
        let open = true;
        setBackgroundGate(() => open);
        await runInBackground(() => bucket.take());
        open = false;
        await expect(runInBackground(() => bucket.take())).rejects.toBeInstanceOf(BackgroundYield);
        // Users and idle screens are never held by the gate.
        await expect(bucket.take()).resolves.toBeUndefined();
        await expect(runAsUpkeep(() => bucket.take())).resolves.toBeUndefined();
    });

    it('lets a user who joined a request the warmer gave up load it again', async () => {
        const cache = new TtlCache<string>();
        let open = true;
        setBackgroundGate(() => open);
        const bucket = new TokenBucket(600, 2);
        let loads = 0;
        const load = async () => {
            loads += 1;
            await bucket.take();
            return 'bars';
        };
        // The warmer's request waits for room (the bucket is at its half line)...
        await runInBackground(() => bucket.take());
        const warm = runInBackground(() => cache.wrap('k', 1_000, load)).catch((e: unknown) => e);
        // ...a user asks for the same thing, and charting closes the gate.
        const user = cache.wrap('k', 1_000, load);
        open = false;
        expect(await warm).toBeInstanceOf(BackgroundYield);
        expect(await user).toBe('bars');
        expect(loads).toBe(2);
    });
});
