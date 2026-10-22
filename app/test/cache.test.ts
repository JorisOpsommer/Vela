// The on-disk market-data cache: answers from stored bars where it provably holds them,
// tops them up with only the newest stretch, notices rewritten history, serves cache-only
// peeks without a provider call, and forgets what nobody uses.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CachedMarket } from '../server/market/cached-market';
import { CacheStore, seriesKey } from '../server/market/cache-store';
import { Catalog } from '../server/market/catalog';
import { MarketService } from '../server/market/service';
import type { BarRequest, Bridge, OHLCV } from '../server/market/types';
import type { Timeframe } from '../server/market/timeframes';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 21, 12, 0); // Wed Oct 21 2026, 08:00 New York

afterEach(() => {
    vi.useRealTimers();
});

/** One-minute bars on every minute up to now, priced by `price(t)`. */
function minuteSource(id: Bridge['id'], price: (t: number) => number) {
    const calls: BarRequest[] = [];
    const bridge: Bridge = {
        id,
        pollMs: 60_000,
        supports: () => true,
        async getBars(_ticker: string, tf: Timeframe, req: BarRequest): Promise<OHLCV[]> {
            calls.push({ ...req });
            const step = tf.n * MIN;
            const now = Date.now();
            const to = Math.min(req.to ?? now, now);
            const from = req.from ?? to - (req.limit ?? 500) * step;
            const out: OHLCV[] = [];
            for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push({ time: t, open: price(t), high: price(t) + 1, low: price(t) - 1, close: price(t), volume: 1 });
            return req.limit != null ? out.slice(-req.limit) : out;
        },
    };
    return { bridge, calls };
}

function setup(price: (t: number) => number = (t) => 100 + (t % 7)) {
    const src = minuteSource('yahoo', price);
    const catalog = new Catalog(
        { groups: [], instruments: { IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' } } },
        { alpaca: false, finnhub: false },
    );
    const market = new MarketService(catalog, { yahoo: src.bridge });
    const store = new CacheStore(':memory:');
    return { src, cached: new CachedMarket(market, store), store };
}

function contiguous(bars: OHLCV[], step: number): boolean {
    return bars.every((b, i) => i === 0 || b.time - bars[i - 1]!.time === step);
}

describe('CachedMarket — bars', () => {
    it('writes an answer through, then tops it up with only the newest stretch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { src, cached } = setup();
        const first = await cached.bars('IDX', '1', { limit: 120 });
        expect(first.cache).toBe('fetched');
        expect(first.bars).toHaveLength(120);

        vi.setSystemTime(T0 + 10 * MIN);
        const second = await cached.bars('IDX', '1', { limit: 120 });
        expect(second.cache).toBe('merged');
        // The top-up starts at the newest final bars, not 120 bars back.
        expect(src.calls[1]!.from).toBeGreaterThan(T0 - 10 * MIN);
        expect(src.calls[1]!.limit).toBeUndefined();
        expect(second.bars).toHaveLength(120);
        expect(second.bars[second.bars.length - 1]!.time).toBe(T0 + 10 * MIN);
        expect(contiguous(second.bars, MIN)).toBe(true);
        expect(cached.counters.merged).toBe(1);
    });

    it('refetches everything when the provider rewrote the stored history (a split)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        let factor = 1;
        const { src, cached, store } = setup((t) => (100 + (t % 7)) * factor);
        await cached.bars('IDX', '1', { limit: 120 });
        factor = 0.5;
        vi.setSystemTime(T0 + 5 * MIN);
        const after = await cached.bars('IDX', '1', { limit: 120 });
        expect(after.cache).toBe('fetched');
        expect(cached.counters.replaced).toBe(1);
        // Every bar now carries the new prices; none of the old ones survived.
        expect(after.bars.every((b) => b.close === (100 + (b.time % 7)) * 0.5)).toBe(true);
        expect(store.bars(seriesKey('IDX', '1', 'all')).every((b) => b.close === (100 + (b.time % 7)) * 0.5)).toBe(true);
        expect(store.events().some((e) => e.kind === 'replaced')).toBe(true);
        expect(src.calls.length).toBe(3); // the first load, the top-up that caught it, the refetch
    });

    it('serves a backfill the stored stretch holds without a provider call', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { src, cached } = setup();
        await cached.bars('IDX', '1', { limit: 200 });
        const n = src.calls.length;
        const older = await cached.bars('IDX', '1', { to: T0 - 100 * MIN, limit: 50 });
        expect(older.cache).toBe('range');
        expect(older.bars).toHaveLength(50);
        expect(older.bars[older.bars.length - 1]!.time).toBe(T0 - 100 * MIN);
        expect(src.calls.length).toBe(n);
        // Beyond the stored stretch it goes to the provider.
        const deeper = await cached.bars('IDX', '1', { to: T0 - 190 * MIN, limit: 50 });
        expect(deeper.cache).toBe('fetched');
        expect(src.calls.length).toBe(n + 1);
    });

    it('keeps the history when a short poll for the newest bars lands', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { cached, store } = setup();
        await cached.bars('IDX', '1', { limit: 120 });
        vi.setSystemTime(T0 + 30_000);
        // A refresh of the forming bar only, past the settled stretch.
        await cached.bars('IDX', '1', { from: T0, limit: 4 });
        expect(store.series(seriesKey('IDX', '1', 'all'))?.bars).toBe(120);
        // One that touches nothing stored is not written at all.
        await cached.bars('IDX', '1', { from: T0 - 500 * MIN, to: T0 - 400 * MIN });
        expect(store.series(seriesKey('IDX', '1', 'all'))?.bars).toBe(120);
        expect(store.bars(seriesKey('IDX', '1', 'all'))[0]!.time).toBe(T0 - 119 * MIN);
    });

    it('passes small live-tail polls through without storing them', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { cached, store } = setup();
        const r = await cached.bars('IDX', '1', { limit: 3 });
        expect(r.cache).toBe('passthrough');
        expect(store.series(seriesKey('IDX', '1', 'all'))).toBeUndefined();
    });

    it('peeks at stored bars without calling a provider', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { src, cached } = setup();
        expect(await cached.peek('IDX', '1', { limit: 100 })).toBeNull();
        await cached.bars('IDX', '1', { limit: 120 });
        const n = src.calls.length;
        vi.setSystemTime(T0 + 30 * MIN);
        const peek = await cached.peek('IDX', '1', { limit: 100 });
        expect(peek?.bars).toHaveLength(100);
        expect(peek?.bars[99]!.time).toBe(T0);
        expect(peek?.asOf).toBe(T0);
        expect(peek?.complete).toBe(false);
        expect(src.calls.length).toBe(n);
    });
});

describe('CachedMarket — a closed US session', () => {
    function usSetup() {
        const src = minuteSource('alpaca', (t) => 200 + (t % 5));
        const calendar = async (from: number, to: number) => {
            const days = new Map<string, { open: number; close: number; sessionOpen: number; sessionClose: number }>();
            for (let t = Math.floor(from / DAY) * DAY; t <= to; t += DAY) {
                const d = new Date(t);
                if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
                const at = (h: number) => t + (h + 4) * 3_600_000; // EDT
                days.set(d.toISOString().slice(0, 10), { open: at(9.5), close: at(16), sessionOpen: at(4), sessionClose: at(20) });
            }
            return days;
        };
        const alpaca = Object.assign(src.bridge, { calendar });
        const catalog = new Catalog({ groups: [], instruments: {} }, { alpaca: true, finnhub: false });
        const market = new MarketService(catalog, { alpaca: alpaca as never });
        return { src, cached: new CachedMarket(market, new CacheStore(':memory:')) };
    }

    it('answers entirely from the cache once the session closed after the fetch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.UTC(2026, 9, 21, 22, 0)); // 18:00 New York, after the close
        const { src, cached } = usSetup();
        await cached.bars('AAPL', '5', { limit: 100 });
        const n = src.calls.length;
        vi.setSystemTime(Date.UTC(2026, 9, 22, 2, 0)); // 22:00 New York
        const again = await cached.bars('AAPL', '5', { limit: 100 });
        expect(again.cache).toBe('complete');
        expect(again.bars).toHaveLength(100);
        expect(src.calls.length).toBe(n);
        expect((await cached.peek('AAPL', '5', { limit: 100 }))?.complete).toBe(true);

        vi.setSystemTime(Date.UTC(2026, 9, 22, 15, 0)); // 11:00 New York, open again
        expect((await cached.bars('AAPL', '5', { limit: 100 })).cache).toBe('merged');
    });
});

describe('CacheStore — writes', () => {
    it('keeps a deep history when a short answer arrives from a fallback source', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const store = new CacheStore(':memory:');
        const meta = { symbol: 'IDX', tf: '1', session: 'all' };
        const key = seriesKey('IDX', '1', 'all');
        const deep = Array.from({ length: 1_000 }, (_, i) => ({ time: T0 - (999 - i) * MIN, open: 1, high: 1, low: 1, close: 1 }));
        store.write({ ...meta, source: 'alpaca' }, deep, { coverTo: T0, settledTo: T0 - 2 * MIN, reachesNow: true, depth: 1_000 });
        // A refresh of the newest bars that one source missed and another answered.
        store.write({ ...meta, source: 'yahoo' }, deep.slice(-2).map((b) => ({ ...b, close: 1.001 })), { coverTo: T0, settledTo: T0 - 2 * MIN, reachesNow: true });
        expect(store.series(key)).toMatchObject({ source: 'alpaca', bars: 1_000 });
        expect(store.bars(key)).toHaveLength(1_000);
        // A full initial load from the other source does take over.
        store.write({ ...meta, source: 'yahoo' }, deep.slice(-500), { coverTo: T0, settledTo: T0 - 2 * MIN, reachesNow: true, depth: 500 });
        expect(store.series(key)).toMatchObject({ source: 'yahoo', bars: 500 });
    });
});

describe('CacheStore — housekeeping', () => {
    it('purges series and quotes nobody read or refreshed within the retention window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { cached, store } = setup();
        await cached.bars('IDX', '1', { limit: 100 });
        store.putQuotes([{ symbol: 'IDX' }]);
        vi.setSystemTime(T0 + 4 * DAY);
        expect(store.purge().series).toBe(0);
        // Reading counts as use: a peek on day 4 keeps the series past day 6.
        await cached.peek('IDX', '1', { limit: 10 });
        vi.setSystemTime(T0 + 6 * DAY);
        const removed = store.purge();
        expect(removed).toMatchObject({ series: 0, quotes: 1 });
        vi.setSystemTime(T0 + 10 * DAY);
        expect(store.purge().series).toBe(1);
        expect(store.totals()).toMatchObject({ series: 0, bars: 0, quotes: 0 });
    });

    it('keeps at most the newest bars per series', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0);
        const { cached, store } = setup();
        await cached.bars('IDX', '1', { limit: 2_500 });
        const s = store.series(seriesKey('IDX', '1', 'all'))!;
        expect(s.bars).toBe(2_000);
        expect(store.bars(s.key)).toHaveLength(2_000);
        expect(s.coveredFrom).toBe(store.bars(s.key, { limit: 2_000 })[0]!.time);
    });
});
