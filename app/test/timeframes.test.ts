import { describe, expect, it } from 'vitest';
import { aggregate, bucketStart, clip, localDate, normalizeBars, parseTimeframe, zonedWallTime } from '../server/market/timeframes';
import { alpacaTimeframe, mergeTail, planBase } from '../server/market/bridges/alpaca';
import { chunksBetween } from '../server/market/bridges/energycharts';
import { sessionOpenOfDay, yahooPlan } from '../server/market/bridges/yahoo';

const NY = 'America/New_York';
const iso = (s: string) => Date.parse(s);

describe('parseTimeframe', () => {
    it('reads Vela canonical strings', () => {
        expect(parseTimeframe('5')).toEqual({ unit: 'minute', n: 5 });
        expect(parseTimeframe('240')).toEqual({ unit: 'minute', n: 240 });
        expect(parseTimeframe('D')).toEqual({ unit: 'day', n: 1 });
        expect(parseTimeframe('2W')).toEqual({ unit: 'week', n: 2 });
        expect(parseTimeframe('M')).toEqual({ unit: 'month', n: 1 });
        expect(parseTimeframe('4h')).toEqual({ unit: 'minute', n: 240 });
        expect(parseTimeframe('bogus')).toBeNull();
        expect(parseTimeframe('0')).toBeNull();
    });
});

describe('bucketStart', () => {
    it('anchors hourly equity buckets on the 09:30 open', () => {
        const t = iso('2026-10-20T15:10:00Z'); // 11:10 New York (EDT)
        expect(new Date(bucketStart({ unit: 'minute', n: 60 }, t, NY, 9.5 * 3_600_000)).toISOString()).toBe('2026-10-20T14:30:00.000Z');
    });
    it('puts daily buckets at local midnight across DST', () => {
        expect(new Date(bucketStart({ unit: 'day', n: 1 }, iso('2026-07-01T18:00:00Z'), NY)).toISOString()).toBe('2026-07-01T04:00:00.000Z');
        expect(new Date(bucketStart({ unit: 'day', n: 1 }, iso('2026-12-01T18:00:00Z'), NY)).toISOString()).toBe('2026-12-01T05:00:00.000Z');
    });
    it('starts weeks on Monday and months on the 1st', () => {
        expect(new Date(bucketStart({ unit: 'week', n: 1 }, iso('2026-10-22T12:00:00Z'), 'Etc/UTC')).toISOString()).toBe('2026-10-19T00:00:00.000Z');
        expect(new Date(bucketStart({ unit: 'month', n: 1 }, iso('2026-10-22T12:00:00Z'), 'Europe/Brussels')).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    });
    it('resolves wall times on a DST-change day', () => {
        // 2026-11-01: New York falls back at 02:00; the open is still 09:30 local (14:30Z).
        expect(new Date(zonedWallTime(NY, 2026, 10, 1, 9.5 * 3_600_000)).toISOString()).toBe('2026-11-01T14:30:00.000Z');
        expect(localDate('Asia/Tokyo', iso('2026-10-19T15:00:00Z'))).toBe('2026-10-20');
    });
});

describe('aggregate / normalize / clip', () => {
    const bar = (t: string, o: number, h: number, l: number, c: number, v = 1) => ({ time: iso(t), open: o, high: h, low: l, close: c, volume: v });
    it('folds bars into OHLCV buckets', () => {
        const out = aggregate([bar('2026-10-20T14:30:00Z', 1, 2, 0.5, 1.5), bar('2026-10-20T15:00:00Z', 1.5, 3, 1, 2.5), bar('2026-10-20T15:30:00Z', 2.5, 2.6, 2, 2.2)], { unit: 'minute', n: 60 }, NY, 9.5 * 3_600_000);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ open: 1, high: 3, low: 0.5, close: 2.5, volume: 2 });
    });
    it('sorts, dedupes and drops non-finite rows', () => {
        const out = normalizeBars([bar('2026-01-02T00:00:00Z', 1, 1, 1, 1), bar('2026-01-01T00:00:00Z', 1, 1, 1, 1), bar('2026-01-02T00:00:00Z', 2, 2, 2, 2), { time: 5, open: NaN, high: 1, low: 1, close: 1 }]);
        expect(out.map((b) => b.open)).toEqual([1, 2]);
        expect(clip(out, { limit: 1 })).toHaveLength(1);
    });
});

describe('Alpaca planning', () => {
    it('uses native bars only when the alignment matches', () => {
        expect(planBase({ unit: 'minute', n: 5 }, false, true).base).toEqual({ unit: 'minute', n: 5 });
        expect(planBase({ unit: 'minute', n: 60 }, false, true)).toEqual({ base: { unit: 'minute', n: 30 }, anchorMs: 9.5 * 3_600_000 });
        expect(planBase({ unit: 'minute', n: 240 }, false, false)).toEqual({ base: { unit: 'minute', n: 60 }, anchorMs: 4 * 3_600_000 });
        expect(planBase({ unit: 'day', n: 2 }, false, true).base).toEqual({ unit: 'day', n: 1 });
        expect(alpacaTimeframe({ unit: 'minute', n: 120 })).toBe('2Hour');
        expect(alpacaTimeframe({ unit: 'month', n: 5 })).toBeNull();
    });
    it('merges the real-time tail onto delayed history', () => {
        const t = iso('2026-10-20T15:00:00Z');
        const merged = mergeTail([{ time: t, open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }], [{ time: t, open: 10.2, high: 12, low: 9.5, close: 11.8, volume: 30 }, { time: t + 60_000, open: 11.8, high: 11.9, low: 11.7, close: 11.75, volume: 5 }]);
        expect(merged[0]).toEqual({ time: t, open: 10, high: 12, low: 9, close: 11.8, volume: 1000 });
        expect(merged).toHaveLength(2);
    });
});

describe('Yahoo planning', () => {
    it('picks the largest interval that divides the timeframe', () => {
        expect(yahooPlan({ unit: 'minute', n: 240 }).interval).toBe('60m');
        expect(yahooPlan({ unit: 'minute', n: 45 }).interval).toBe('15m');
        expect(yahooPlan({ unit: 'day', n: 3 }).interval).toBe('1d');
        expect(yahooPlan({ unit: 'week', n: 1 }).interval).toBe('1wk');
    });
    it('finds the venue session open from the first bar of each day', () => {
        const bars = ['2026-10-19T13:30:00Z', '2026-10-19T14:30:00Z', '2026-10-20T13:30:00Z', '2026-10-20T14:30:00Z'].map((t) => ({ time: iso(t), open: 1, high: 1, low: 1, close: 1 }));
        expect(sessionOpenOfDay(bars, NY)).toBe(9.5 * 3_600_000);
    });
});

describe('Energy-Charts ranges', () => {
    it('fetches closed years whole and only the current month as open', () => {
        const now = iso('2026-10-20T12:00:00Z');
        const chunks = chunksBetween(iso('2024-06-01T00:00:00Z'), now + 2 * 86_400_000, now);
        expect(chunks).toEqual([
            { start: '2024-01-01', end: '2024-12-31', closed: true },
            { start: '2025-01-01', end: '2025-12-31', closed: true },
            { start: '2026-01-01', end: '2026-09-30', closed: true },
            { start: '2026-10-01', end: '2026-10-31', closed: false },
        ]);
    });
    it('reaches into next month when tomorrow is in it', () => {
        const now = iso('2026-10-31T14:00:00Z');
        const chunks = chunksBetween(now - 86_400_000, now + 2 * 86_400_000, now);
        expect(chunks.map((c) => c.start)).toEqual(['2026-10-01', '2026-11-01']);
    });
});
