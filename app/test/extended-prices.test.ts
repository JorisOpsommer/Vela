// Real-time pre/post-market prices: Yahoo's tape is classified against its trading periods,
// the consolidated snapshot's against the exchange calendar; outside regular hours the
// service splices Yahoo's real-time tail onto the delayed tape and prefers its quotes,
// falling back to the delayed ones whenever Yahoo fails or its budget runs short.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendedFromChart, YahooBridge } from '../server/market/bridges/yahoo';
import { extendedFromSnapshot, type CalendarDay, type RawSnapshot } from '../server/market/bridges/alpaca';
import { Catalog } from '../server/market/catalog';
import { MarketService, spliceTail } from '../server/market/service';
import type { Bridge, ExtendedQuote, OHLCV, Quote } from '../server/market/types';
import { UpstreamError } from '../server/market/types';

// Wed Oct 21 2026 (EDT, UTC-4): pre 04:00, regular 09:30–16:00, post until 20:00 ET.
const T = (h: number, m = 0, day = 21): number => Date.UTC(2026, 9, day, h + 4, m);
const DAY: CalendarDay = { open: T(9, 30), close: T(16), sessionOpen: T(4), sessionClose: T(20) };
const PREV: CalendarDay = { open: T(9, 30, 20), close: T(16, 0, 20), sessionOpen: T(4, 0, 20), sessionClose: T(20, 0, 20) };
const CAL = new Map([
    ['2026-10-20', PREV],
    ['2026-10-21', DAY],
]);
const bar = (time: number, close: number): OHLCV => ({ time, open: close, high: close, low: close, close, volume: 1 });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('extendedFromChart', () => {
    const periods = { pre: [[{ start: T(4) / 1000, end: T(9, 30) / 1000 }]], regular: [[{ start: T(9, 30) / 1000, end: T(16) / 1000 }]], post: [[{ start: T(16) / 1000, end: T(20) / 1000 }]] };
    const meta = { regularMarketPrice: 340, tradingPeriods: periods };

    it('the newest priced point in the post-market is a post price measured from the close', () => {
        const ts = [T(15, 59), T(16, 30), T(16, 31)].map((t) => t / 1000);
        expect(extendedFromChart(meta, ts, [339.9, 341, null])).toEqual({ session: 'post', price: 341, base: 340, time: T(16, 30) });
    });

    it('a pre-market point is a pre price; a regular one is none', () => {
        expect(extendedFromChart(meta, [T(9, 0) / 1000], [338])?.session).toBe('pre');
        expect(extendedFromChart(meta, [T(11) / 1000], [338])).toBeNull();
        expect(extendedFromChart(meta, [], [])).toBeNull();
    });
});

describe('extendedFromSnapshot', () => {
    const daily = { t: '2026-10-21T04:00:00Z', o: 1, h: 1, l: 1, v: 1, c: 340 };
    const prevDaily = { t: '2026-10-20T04:00:00Z', o: 1, h: 1, l: 1, v: 1, c: 339.5 };
    const snap = (iso: string, p: number): RawSnapshot => ({ latestTrade: { p, t: iso }, dailyBar: daily, prevDailyBar: prevDaily });

    it('after the close: post, from the same day close', () => {
        expect(extendedFromSnapshot(snap('2026-10-21T21:00:00Z', 341), CAL)).toEqual({ session: 'post', price: 341, base: 340, time: T(17) });
    });

    it('before the open: pre, from the previous day close', () => {
        expect(extendedFromSnapshot({ ...snap('2026-10-21T12:00:00Z', 338), dailyBar: prevDaily, prevDailyBar: undefined }, CAL)).toEqual({ session: 'pre', price: 338, base: 339.5, time: T(8) });
        expect(extendedFromSnapshot(snap('2026-10-21T12:00:00Z', 338), CAL)?.base).toBe(339.5);
    });

    it('regular hours, or outside the tape, is none', () => {
        expect(extendedFromSnapshot(snap('2026-10-21T15:00:00Z', 340), CAL)).toBeNull();
        expect(extendedFromSnapshot(snap('2026-10-22T01:00:00Z', 340), CAL)).toBeNull();
    });
});

describe('spliceTail', () => {
    it('takes over from the delayed tape newest bar onward', () => {
        const delayed = [bar(1, 10), bar(2, 11), bar(3, 12)];
        const tail = [bar(2, 99), bar(3, 13), bar(4, 14)];
        expect(spliceTail(delayed, tail).map((b) => [b.time, b.close])).toEqual([
            [1, 10],
            [2, 11],
            [3, 13],
            [4, 14],
        ]);
    });

    it('an empty or older tail leaves the delayed bars', () => {
        expect(spliceTail([bar(5, 1)], [])).toEqual([bar(5, 1)]);
        expect(spliceTail([bar(5, 1)], [bar(4, 2)])).toEqual([bar(5, 1)]);
    });
});

// ── the service ──

function fakeAlpaca(delayed: OHLCV[], extended: ExtendedQuote | undefined): Bridge & { calendar(): Promise<Map<string, CalendarDay>> } {
    return {
        id: 'alpaca',
        pollMs: 15_000,
        supports: () => true,
        getBars: async () => delayed,
        quotes: async (tickers) => new Map<string, Quote>(tickers.map((t) => [t, { price: 340, prevClose: 339.5, time: T(16), ...(extended ? { extended } : {}) }])),
        calendar: async () => CAL,
    };
}

function fakeYahoo(opts: { tail?: OHLCV[]; fail?: boolean; ext?: Map<string, ExtendedQuote> }): Bridge & { calls: string[] } {
    const calls: string[] = [];
    return {
        id: 'yahoo',
        pollMs: 60_000,
        calls,
        supports: () => true,
        async getBars(_t, _tf, req) {
            calls.push(`bars:${req.session}`);
            if (opts.fail) throw new UpstreamError('rate budget exhausted', 429, 30_000);
            return opts.tail ?? [];
        },
        async extendedQuotes() {
            calls.push('ext');
            if (opts.fail) throw new UpstreamError('rate budget exhausted', 429, 30_000);
            return opts.ext ?? new Map();
        },
    };
}

function service(alpaca: ReturnType<typeof fakeAlpaca>, yahoo: ReturnType<typeof fakeYahoo>): MarketService {
    const catalog = new Catalog({ groups: [], instruments: {} }, { alpaca: true, finnhub: false });
    return new MarketService(catalog, { alpaca: alpaca as never, yahoo });
}

describe('MarketService — real-time extended hours', () => {
    it('splices the real-time tail onto the delayed extended tape after the close', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(16, 20));
        const yahoo = fakeYahoo({ tail: [bar(T(16, 4), 341), bar(T(16, 19), 342.5)] });
        const m = service(fakeAlpaca([bar(T(15, 59), 340), bar(T(16, 4), 340.8)], undefined), yahoo);
        const { bars } = await m.getBars('AAPL', '1', { limit: 3, session: 'extended' });
        expect(bars.map((b) => [b.time, b.close])).toEqual([
            [T(15, 59), 340],
            [T(16, 4), 341],
            [T(16, 19), 342.5],
        ]);
    });

    it('falls back to the delayed tape when Yahoo is out of budget', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(16, 20));
        const delayed = [bar(T(15, 59), 340), bar(T(16, 4), 340.8)];
        const m = service(fakeAlpaca(delayed, undefined), fakeYahoo({ fail: true }));
        expect((await m.getBars('AAPL', '1', { session: 'extended' })).bars).toEqual(delayed);
    });

    it('leaves regular-hours and regular-session requests alone', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(11));
        const yahoo = fakeYahoo({ tail: [bar(T(11), 1)] });
        const m = service(fakeAlpaca([bar(T(10, 59), 340)], undefined), yahoo);
        await m.getBars('AAPL', '1', { session: 'extended' });
        vi.setSystemTime(T(17));
        await m.getBars('AAPL', '1', { session: 'regular' });
        expect(yahoo.calls).toEqual([]);
    });

    it('quotes carry the newest pre/post price: real time when Yahoo answers, delayed otherwise', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(17));
        const delayed: ExtendedQuote = { session: 'post', price: 341, base: 340, time: T(16, 45) };
        const live: ExtendedQuote = { session: 'post', price: 342, base: 340, time: T(16, 59) };
        const withLive = service(fakeAlpaca([], delayed), fakeYahoo({ ext: new Map([['AAPL', live]]) }));
        const [a] = await withLive.quotes(['AAPL']);
        expect(a!.extended).toMatchObject({ session: 'post', price: 342, change: 2 });
        expect(a!.extended!.changePct).toBeCloseTo(0.588, 3);
        const capped = service(fakeAlpaca([], delayed), fakeYahoo({ fail: true }));
        const [b] = await capped.quotes(['AAPL']);
        expect(b!.extended).toMatchObject({ session: 'post', price: 341, change: 1 });
    });

    it('no pre/post price while the regular session is open', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(11));
        const yahoo = fakeYahoo({ ext: new Map() });
        const m = service(fakeAlpaca([], { session: 'pre', price: 338, base: 339.5, time: T(9) }), yahoo);
        const [q] = await m.quotes(['AAPL']);
        expect(q!.extended).toBeUndefined();
        expect(yahoo.calls).toEqual([]);
    });
});

// ── the Yahoo budget ──

describe('YahooBridge.extendedQuotes', () => {
    it('spends only spare budget, keeps a reserve for charts, and serves what it has cached', async () => {
        const body = {
            chart: {
                error: null,
                result: [
                    {
                        meta: { regularMarketPrice: 340, tradingPeriods: { post: [[{ start: T(16) / 1000, end: T(20) / 1000 }]] } },
                        timestamp: [T(17) / 1000],
                        indicators: { quote: [{ open: [341], high: [341], low: [341], close: [341], volume: [1] }] },
                    },
                ],
            },
        };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        const y = new YahooBridge();
        const tickers = Array.from({ length: 20 }, (_, i) => `T${i}`);
        const first = await y.extendedQuotes(tickers);
        // The bucket bursts to 8 and keeps 4 back: at most 4 fetches.
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
        expect(first.size).toBe(fetchMock.mock.calls.length);
        expect([...first.values()][0]).toEqual({ session: 'post', price: 341, base: 340, time: T(17) });
        const second = await y.extendedQuotes(tickers);
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4); // no spare budget left yet
        expect(second.size).toBe(first.size); // the fetched ones are still served
    });
});

