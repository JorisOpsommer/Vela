// Trend detection: the shapes a trader would draw, on shaped series and on real history.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adx, atrSeries, detect, markConfluence, zigzag, type TrendTf } from '../server/trends/detect';
import type { OHLCV } from '../server/market/types';

const DAY = 86_400_000;
const FIXTURES = path.join(__dirname, 'fixtures', 'trends');

function fixture(name: string): OHLCV[] {
    return (JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as number[][]).map(([time, open, high, low, close, volume]) => ({
        time: time!,
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        volume: volume!,
    }));
}

/** Bars following `path(i)` as their close, each with a fixed range around it. */
function series(n: number, path: (i: number) => number, range = 1): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i++) {
        const c = path(i);
        const o = i === 0 ? c : path(i - 1);
        out.push({ time: Date.UTC(2024, 0, 1) + i * DAY, open: o, high: Math.max(o, c) + range / 2, low: Math.min(o, c) - range / 2, close: c, volume: 1000 });
    }
    return out;
}

/** A triangle wave between `lo` and `hi` with period `p`, plus `drift` per bar. */
const wave = (lo: number, hi: number, p: number, drift = 0) => (i: number) => {
    const t = (i % p) / p;
    return lo + (hi - lo) * (t < 0.5 ? t * 2 : 2 - t * 2) + drift * i;
};

describe('indicators', () => {
    it('measures ATR as the average true range', () => {
        const bars = series(40, () => 100, 2);
        expect(atrSeries(bars).at(-1)).toBeCloseTo(2, 6);
        expect(atrSeries(bars)[5]).toBeNull();
    });

    it('reads a steady climb as trending and a flat line as not', () => {
        expect(adx(series(200, (i) => 100 + i, 1))!).toBeGreaterThan(40);
        expect(adx(series(200, wave(100, 104, 10), 1))!).toBeLessThan(25);
    });

    it('confirms a swing only once price has reversed far enough', () => {
        const bars = series(200, wave(100, 130, 40), 1);
        const swings = zigzag(bars, atrSeries(bars), 2);
        const highs = swings.filter((s) => s.high);
        expect(highs.length).toBeGreaterThanOrEqual(3);
        for (const h of highs) expect(h.price).toBeCloseTo(130.5, 0);
        // Highs and lows alternate.
        for (let i = 1; i < swings.length; i++) expect(swings[i]!.high).not.toBe(swings[i - 1]!.high);
    });
});

describe('levels and lines on shaped series', () => {
    it('marks the floor and ceiling of a range, and calls it a range', () => {
        const bars = series(400, wave(100, 120, 30), 1);
        // End mid-range so neither level is being tested.
        const d = detect(bars.slice(0, 397), 'D')!;
        const support = d.shapes.find((s) => s.kind === 'support')!;
        const resistance = d.shapes.find((s) => s.kind === 'resistance')!;
        expect((support.anchors[0].price + support.anchors[1].price) / 2).toBeCloseTo(99.5, 0);
        expect((resistance.anchors[0].price + resistance.anchors[1].price) / 2).toBeCloseTo(120.5, 0);
        expect(support.touches).toBeGreaterThanOrEqual(3);
        expect(d.trend.state).toBe('range');
    });

    it('draws a rising trend line under higher lows, and calls the trend up', () => {
        const bars = series(400, wave(100, 112, 40, 0.15), 1);
        const d = detect(bars, 'D')!;
        const line = d.shapes.find((s) => s.kind === 'trendline-up');
        expect(line).toBeDefined();
        expect(line!.anchors[1].price).toBeGreaterThan(line!.anchors[0].price);
        expect(line!.touches).toBeGreaterThanOrEqual(3);
        expect(line!.status).not.toBe('broken');
        expect(d.trend.state).toBe('up');
        expect(d.shapes.some((s) => s.kind === 'trendline-down')).toBe(false);
    });

    it('reports a fresh break of a rising line', () => {
        const up = wave(100, 112, 40, 0.15);
        const bars = series(400, (i) => (i < 396 ? up(i) : up(395) - (i - 395) * 6), 1);
        const d = detect(bars, 'D')!;
        expect(d.shapes.some((s) => s.kind === 'trendline-up' && s.status === 'broken')).toBe(true);
        expect(d.signals.some((g) => g.kind === 'trendline-break')).toBe(true);
    });

    it('needs enough history to say anything', () => {
        expect(detect(series(60, (i) => 100 + i), 'D')).toBeNull();
    });
});

describe('real history', () => {
    const cases: Array<[string, TrendTf]> = ['AAPL', 'NVDA', 'SPY', 'XOM', 'TSLA'].flatMap((s) => [[`${s}-D`, 'D'] as [string, TrendTf], [`${s}-240`, '240'] as [string, TrendTf]]);

    it.each(cases)('%s: levels sit on the right side of price, lines hold between their swings', (name, tf) => {
        const bars = fixture(name);
        const d = detect(bars, tf)!;
        expect(d).not.toBeNull();
        expect(d.asOf).toBe(bars.at(-1)!.time);
        const close = d.close;
        const maxDistance = tf === 'D' ? 0.3 : 0.15;
        const boxes = d.shapes.filter((s) => s.kind === 'support' || s.kind === 'resistance');
        const lines = d.shapes.filter((s) => s.kind.startsWith('trendline'));
        expect(boxes.filter((s) => s.kind === 'support').length).toBeLessThanOrEqual(3);
        expect(boxes.filter((s) => s.kind === 'resistance').length).toBeLessThanOrEqual(3);
        expect(lines.filter((s) => s.kind === 'trendline-up').length).toBeLessThanOrEqual(2);
        for (const b of boxes) {
            const [top, bottom] = [b.anchors[0].price, b.anchors[1].price];
            expect(top).toBeGreaterThan(bottom);
            const mid = (top + bottom) / 2;
            expect(Math.abs(mid - close) / close).toBeLessThanOrEqual(maxDistance);
            // A support's floor is under the price, a resistance's ceiling over it.
            if (b.kind === 'support') expect(bottom).toBeLessThan(close);
            else expect(top).toBeGreaterThan(close);
            expect(b.score).toBeGreaterThanOrEqual(20);
        }
        // Boxes never overlap: one area, one box.
        for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.anchors[1].price > b.anchors[0].price || a.anchors[0].price < b.anchors[1].price).toBe(true);
        // No close crosses a line between its two swings.
        const atr = atrSeries(bars);
        for (const l of lines) {
            const ia = bars.findIndex((b) => b.time === l.anchors[0].time);
            const ib = bars.findIndex((b) => b.time === l.anchors[1].time);
            expect(ib).toBeGreaterThan(ia);
            const at = (i: number) => Math.exp(Math.log(l.anchors[0].price) + ((Math.log(l.anchors[1].price) - Math.log(l.anchors[0].price)) * (i - ia)) / (ib - ia));
            for (let i = ia + 1; i < ib; i++) {
                const tol = 0.25 * atr[i]!;
                if (l.kind === 'trendline-up') expect(bars[i]!.close).toBeGreaterThanOrEqual(at(i) - tol);
                else expect(bars[i]!.close).toBeLessThanOrEqual(at(i) + tol);
            }
        }
        // Same bars, same read.
        expect(detect(bars, tf)).toEqual(d);
    });

    it('reads SPY on 4h as a range: a ceiling near 780 over a floor it is testing near 760', () => {
        const d = detect(fixture('SPY-240'), '240')!;
        expect(d.trend.state).toBe('range');
        const r = d.shapes.find((s) => s.kind === 'resistance')!;
        const s = d.shapes.find((x) => x.kind === 'support')!;
        expect((r.anchors[0].price + r.anchors[1].price) / 2).toBeCloseTo(780, -1);
        expect((s.anchors[0].price + s.anchors[1].price) / 2).toBeCloseTo(760, -1);
        expect(s.status).toBe('testing');
    });

    it('keeps a level known by the same id as new bars arrive', () => {
        const bars = fixture('SPY-D');
        const before = detect(bars.slice(0, -3), 'D')!;
        const after = detect(bars, 'D')!;
        const ids = (d: typeof before) => new Set(d.shapes.map((s) => s.id));
        const kept = [...ids(before)].filter((id) => ids(after).has(id));
        expect(kept.length).toBeGreaterThanOrEqual(Math.min(ids(before).size, ids(after).size) - 1);
    });

    it('marks levels that line up on both timeframes', () => {
        const d = detect(fixture('SPY-D'), 'D')!;
        const h = detect(fixture('SPY-240'), '240')!;
        markConfluence(d, h);
        const both = d.shapes.filter((s) => s.confluence);
        expect(both.length).toBeGreaterThan(0);
        expect(h.shapes.some((s) => s.confluence)).toBe(true);
    });
});
