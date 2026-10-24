// Zoom-out bound: the view may shrink until all bars + a margin fill the width, even on a
// long history. The hard per-bar pixel floor must not cut that short.
import { describe, it, expect } from 'vitest';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import type { OHLCV } from '../src/core/model/ohlcv';

const T0 = 1_700_000_000_000;
const STEP = 60_000;
const WIDTH = 800;

const mkBars = (n: number): OHLCV[] =>
    Array.from({ length: n }, (_, i) => ({ time: T0 + i * STEP, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));

/* eslint-disable @typescript-eslint/no-explicit-any -- clampViewport is private; the bound it enforces IS the behavior under test */
function makeRenderer(n: number) {
    const r = new NativeRenderer();
    const anyR = r as any;
    anyR.coords.setSize(WIDTH, 200, 1);
    if (!anyR.scheduler) anyR.scheduler = { invalidate: () => {} };
    if (!anyR.animator) anyR.animator = { active: false, start: () => {}, stop: () => {} };
    anyR.introPlayed = true;
    r.setBars(mkBars(n));
    return anyR;
}

describe('zoom-out bound', () => {
    it('lets a long history shrink until every bar and the margin fill the width', () => {
        const anyR = makeRenderer(10_000);
        const v = anyR.clampViewport(1e-3, 0); // ask for far more zoom-out than the width can show
        expect(v.barSpacing).toBeCloseTo(WIDTH / (10_000 + 6), 6); // fit-all, not a fixed pixel floor
    });

    it('keeps the fit-all floor on a short series', () => {
        const anyR = makeRenderer(100);
        const v = anyR.clampViewport(0.1, 0);
        expect(v.barSpacing).toBeCloseTo(WIDTH / (100 + 6), 6); // all 100 bars + margin fill the width
    });
});
