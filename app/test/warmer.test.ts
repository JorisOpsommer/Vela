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
import { activity } from '../server/market/background';
import { collectTargets } from '../server/market/warm-targets';
import type { LiveHub } from '../server/market/live';
import type { BarRequest, Bridge, OHLCV } from '../server/market/types';

const MIN = 60_000;
const OPEN = Date.UTC(2026, 9, 21, 15, 0); // Wed 11:00 New York — regular hours
const CLOSED = Date.UTC(2026, 9, 21, 22, 0); // Wed 18:00 New York

afterEach(() => {
    vi.useRealTimers();
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
    db.prepare("INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (1, 'watchlist', ?, 0)").run(JSON.stringify({ version: 1, groups: [{ name: 'Mine', symbols: ['IDX', 'ALT'] }] }));
    db.prepare("INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (1, 'workspace', ?, 0)").run(JSON.stringify({ version: 1, charts: [{ symbol: 'INDEX:IDX', timeframe: '5', bars: 300 }] }));
    let topics = 0;
    const hub = { stats: () => ({ topics, listeners: topics }) } as unknown as LiveHub;
    const warmer = new CacheWarmer(cached, db, hub, { quietMs: 3 * MIN, stepGapMs: 0, tickMs: 60_000 });
    return { calls, store, cached, db, warmer, setStreams: (n: number) => (topics = n) };
}

describe('collectTargets', () => {
    it('warms the layout chart first, then the watchlist at the used timeframes', () => {
        const { db, cached } = world();
        const plan = collectTargets(db, cached.market.catalog, OPEN);
        // The watchlist asks the same chart deeper: the deeper of the two wins.
        expect(plan.targets[0]).toMatchObject({ symbol: 'IDX', tf: '5', limit: 1000, layout: true });
        expect(plan.targets.map((t) => `${t.symbol}|${t.tf}`).sort()).toEqual(['ALT|5', 'ALT|D', 'IDX|5', 'IDX|D']);
        expect([...plan.watched.keys()].sort()).toEqual(['ALT', 'IDX']);
    });
});

describe('CacheWarmer', () => {
    it('waits for quiet providers, then fills the cache with calls counted as its own', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPEN);
        const { calls, store, warmer } = world();
        activity.record(false); // a user just reached a provider
        vi.setSystemTime(OPEN + MIN);
        await warmer.tick();
        expect(warmer.state).toBe('waiting');
        expect(calls).toHaveLength(0);

        vi.setSystemTime(OPEN + 4 * MIN);
        const userBefore = activity.lastUserCall();
        await warmer.tick();
        expect(calls.length).toBeGreaterThan(0);
        expect(store.series(seriesKey('IDX', '5', 'all'))?.bars).toBe(1000);
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
        const { calls, warmer, store } = world({ onCall: (n) => n === 1 && activity.record(false) });
        vi.setSystemTime(OPEN + 10 * MIN);
        await warmer.tick();
        expect(calls).toHaveLength(1);
        expect(warmer.state).toBe('waiting');
        expect(store.runs()[0]).toMatchObject({ status: 'paused' });
    });

    it('does not start while a chart is streaming', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(OPEN);
        const { calls, warmer, setStreams } = world();
        setStreams(1);
        vi.setSystemTime(OPEN + 20 * MIN);
        await warmer.tick();
        expect(warmer.state).toBe('waiting');
        expect(warmer.reason).toMatch(/stream/);
        expect(calls).toHaveLength(0);
    });

    it('stays off the real-time extended-hours source outside regular hours', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(CLOSED);
        const { calls, warmer, store } = world();
        vi.setSystemTime(CLOSED + 10 * MIN);
        for (let i = 0; i < 5; i++) await warmer.tick(); // one due pass per round
        expect(calls).toHaveLength(0);
        const close = store.runs().find((r) => r.kind === 'close');
        // All four chart targets skipped; only the (empty-handed) quote step ran.
        expect(close).toMatchObject({ status: 'done', skipped: 4, failed: 0 });
    });
});
