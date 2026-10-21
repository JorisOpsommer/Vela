// The pre/post-market price line: the bar-time classification over resolved calendar
// windows, the tracker's lifecycle (hidden while the regular session is open, streamed in
// pre/post-market, read once while closed so the last post-market price stays up), and
// the chrome painting it in the session color, gated by `sessions.extendedPriceLine`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExtendedPriceTracker, extendedSessionAt, type ExtendedPrice } from '../src/widget/extended-price';
import type { MarketWindows } from '../src/widget/market-status';
import type { DataControl } from '../src/core/DataControl';
import type { OHLCV } from '../src/core/model/ohlcv';
import { ChromeRenderer } from '../src/renderers/native/chrome/ChromeRenderer';
import { SceneGraph } from '../src/renderers/native/core/SceneGraph';
import { CoordinateSystem } from '../src/renderers/native/core/CoordinateSystem';
import { defaultChartStyle, mergeConfig, type ChartConfig } from '../src/renderers/native/core/chartConfig';
import { NativeRenderer } from '../src/renderers/native/NativeRenderer';
import { DARK_THEME } from '../src/core/theme';
import { SESSION_POST, SESSION_PRE } from '../src/core/palette';

// Chip text contrast reads colors back through a real canvas — irrelevant here.
vi.mock('../src/renderers/native/chrome/contrast', () => ({ tagTextColor: () => '#ffffff' }));

const NY = 'America/New_York';
// A plain August 2026 week (EDT = UTC-4): Mon 10th … Fri 14th. Regular 09:30–16:00 ET,
// extended 04:00–20:00 ET.
const D = (day: number, h: number, m = 0): number => Date.UTC(2026, 7, day, h, m);
const week = (days: number[]): MarketWindows => ({
    regular: days.map((d) => [D(d, 13, 30), D(d, 20, 0)] as const),
    extended: days.map((d) => [D(d, 8, 0), D(d, 24, 0)] as const),
});
const FULL_WEEK = week([10, 11, 12, 13, 14]);
const EQUITY_SI = { ticker: 'AAPL', session: '0930-1600', session_extended: '0400-2000', timezone: NY };

describe('extendedSessionAt', () => {
    it('a bar before the regular open is pre-market, after the close post-market', () => {
        expect(extendedSessionAt(D(11, 13, 29), FULL_WEEK)).toBe('pre'); // 09:29 ET
        expect(extendedSessionAt(D(11, 20, 0), FULL_WEEK)).toBe('post'); // 16:00 ET
        expect(extendedSessionAt(D(11, 23, 59), FULL_WEEK)).toBe('post'); // 19:59 ET
    });

    it('a regular-hours bar, or one outside every extended window, is none', () => {
        expect(extendedSessionAt(D(11, 19, 59), FULL_WEEK)).toBeNull(); // 15:59 ET
        expect(extendedSessionAt(D(12, 2), FULL_WEEK)).toBeNull(); // 22:00 ET
    });
});

// ── the tracker ──

interface FakeProvider {
    getCalendar?: (ticker: string, range: { from: number; to: number; session?: string }) => Promise<ReadonlyArray<readonly [number, number]>>;
    getBars: (ticker: string, tf: string, range: { limit?: number; session?: string }) => Promise<OHLCV[]>;
    subscribe?: (ticker: string, tf: string, onBar: (bar: OHLCV) => void, opts?: { session?: string }) => () => void;
}

function fakeData(provider: FakeProvider, syminfo: Record<string, unknown> | undefined): DataControl {
    return {
        resolve: (symbol: string) => ({ provider: 'edgx', ticker: symbol }),
        providerInstance: () => provider,
        symbolInfo: () => Promise.resolve(syminfo),
    } as unknown as DataControl;
}

const bar = (time: number, close: number): OHLCV => ({ time, open: close, high: close, low: close, close, volume: 1 });

/** A provider whose extended tape ends at `tail` and whose live stream is captured. */
function equityProvider(tail: OHLCV[]) {
    const calls = { bars: [] as Array<{ tf: string; session?: string }>, subs: 0, unsubs: 0 };
    let push: ((b: OHLCV) => void) | null = null;
    const provider: FakeProvider = {
        getCalendar: (_t, range) => Promise.resolve(range.session === 'regular' ? FULL_WEEK.regular : FULL_WEEK.extended),
        getBars: (_t, tf, range) => {
            calls.bars.push({ tf, session: range.session });
            return Promise.resolve(tail);
        },
        subscribe: (_t, _tf, onBar, opts) => {
            expect(opts?.session).toBe('extended');
            calls.subs += 1;
            push = onBar;
            return () => {
                calls.unsubs += 1;
                push = null;
            };
        },
    };
    return { provider, calls, push: (b: OHLCV) => push?.(b) };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('ExtendedPriceTracker', () => {
    it('in post-market: reads the extended tape, follows its stream, and keeps the price after the tape closes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(11, 22)); // Tue 18:00 ET
        const { provider, calls, push } = equityProvider([bar(D(11, 19, 59), 150), bar(D(11, 21, 59), 151.5)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.bars).toEqual([{ tf: '1', session: 'extended' }]);
        expect(prices).toEqual([{ price: 151.5, session: 'post' }]);
        expect(calls.subs).toBe(1);

        push(bar(D(11, 22, 30), 152.25));
        expect(prices[prices.length - 1]).toEqual({ price: 152.25, session: 'post' });

        // 20:00 ET: the tape closes — every stream ends (the hourly re-check renews it once
        // on the way), and the last post-market price stays.
        await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 60_000);
        expect(calls.unsubs).toBe(calls.subs);
        expect(prices[prices.length - 1]).toEqual({ price: 151.5, session: 'post' }); // re-read from the tape
        const streams = calls.subs;
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(calls.subs).toBe(streams); // closed ⇒ no new stream
        tracker.stop();
        expect(prices[prices.length - 1]).toBeNull();
    });

    it('while the regular session is open: no price and no fetch, until the close', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(11, 19, 58)); // Tue 15:58 ET
        const { provider, calls } = equityProvider([bar(D(11, 20, 0), 149)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(prices).toEqual([]);
        expect(calls.bars).toEqual([]);
        await vi.advanceTimersByTimeAsync(3 * 60_000); // past 16:00 ET
        expect(prices).toEqual([{ price: 149, session: 'post' }]);
        expect(calls.subs).toBe(1);
        tracker.stop();
    });

    it('when closed (weekend), shows the last post-market price without streaming', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(15, 16)); // Sat 12:00 ET
        const { provider, calls } = equityProvider([bar(D(14, 23, 59), 148.1)]); // Fri 19:59 ET
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(prices).toEqual([{ price: 148.1, session: 'post' }]);
        expect(calls.subs).toBe(0);
        tracker.stop();
    });

    it('in pre-market: the first pre-market trade replaces the previous post-market price', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(12, 8, 30)); // Wed 04:30 ET, nothing traded yet today
        const { provider, push } = equityProvider([bar(D(11, 23, 59), 151)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(prices).toEqual([{ price: 151, session: 'post' }]);
        push(bar(D(12, 8, 31), 153.4));
        expect(prices[prices.length - 1]).toEqual({ price: 153.4, session: 'pre' });
        tracker.stop();
    });

    it('at the regular open, the pre-market price comes down and its stream ends', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(12, 13, 29)); // Wed 09:29 ET
        const { provider, calls } = equityProvider([bar(D(12, 13, 28), 153.4)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(prices).toEqual([{ price: 153.4, session: 'pre' }]);
        expect(calls.subs).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000); // 09:30 ET
        expect(prices[prices.length - 1]).toBeNull();
        expect(calls.unsubs).toBe(1);
        expect(calls.bars).toHaveLength(1); // no extended fetch while the session is open
        tracker.stop();
    });

    it('a regular-hours bar on the extended stream takes the price down even before the boundary re-check', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(12, 13, 29));
        const { provider, push } = equityProvider([bar(D(12, 13, 28), 153.4)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        push(bar(D(12, 13, 30), 154)); // the 09:30 bar arrives first
        expect(prices).toEqual([{ price: 153.4, session: 'pre' }, null]);
        tracker.stop();
    });

    it('a tape whose newest bar is regular-hours shows nothing', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(11, 20, 1)); // Tue 16:01 ET, no after-hours trade yet
        const { provider } = equityProvider([bar(D(11, 19, 59), 150)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        expect(prices).toEqual([]);
        tracker.stop();
    });

    it('markets without a day-split extended tape never fetch', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(11, 22));
        const { provider, calls } = equityProvider([bar(D(11, 21, 59), 1)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, { ...EQUITY_SI, session_extended: undefined }), 'X'); // regular-only vocabulary
        tracker.track(fakeData(provider, { ...EQUITY_SI, session_extended: '1700-1600' }), 'ES'); // overnight roll
        tracker.track(fakeData(provider, { ticker: 'BTCUSDT', session: '24x7' }), 'BTCUSDT');
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.bars).toEqual([]);
        expect(prices).toEqual([]);
        tracker.stop();
    });

    it('switching symbols drops the old price at once', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(D(11, 22));
        const { provider } = equityProvider([bar(D(11, 21, 59), 151.5)]);
        const prices: Array<ExtendedPrice | null> = [];
        const tracker = new ExtendedPriceTracker((p) => prices.push(p));
        tracker.track(fakeData(provider, EQUITY_SI), 'AAPL');
        await vi.advanceTimersByTimeAsync(1);
        tracker.track(fakeData(provider, EQUITY_SI), 'MSFT');
        expect(prices).toEqual([{ price: 151.5, session: 'post' }, null]);
        tracker.stop();
    });
});

// ── the chrome ──

interface Stroke {
    color: string;
    y: number;
}

function chromeRecorder() {
    const strokes: Stroke[] = [];
    const fills: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
    const texts: Array<{ text: string; color: string; y: number }> = [];
    let pathY = 0;
    const noop = (): void => {};
    const ctx = {
        font: '',
        textBaseline: '',
        textAlign: '',
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        setTransform: noop,
        clearRect: noop,
        setLineDash: noop,
        translate: noop,
        lineTo: noop,
        fill: noop,
        closePath: noop,
        quadraticCurveTo: noop,
        drawImage: noop,
        save: noop,
        restore: noop,
        beginPath: noop,
        rect: noop,
        clip: noop,
        arc: noop,
        measureText: (t: string) => ({ width: t.length * 6 }),
        moveTo(_x: number, y: number) {
            pathY = y;
        },
        stroke() {
            strokes.push({ color: String(ctx.strokeStyle), y: pathY });
        },
        fillRect(x: number, y: number, w: number, h: number) {
            fills.push({ color: String(ctx.fillStyle), x, y, w, h });
        },
        fillText(text: string, _x: number, y: number) {
            texts.push({ text, color: String(ctx.fillStyle), y });
        },
    };
    const canvas = { width: 364, height: 422, getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { canvas, strokes, fills, texts };
}

function paintChrome(extendedPrice: ExtendedPrice | null, lineOn = true, lastClose = 155) {
    const times = Array.from({ length: 60 }, (_, i) => 1_700_000_000_000 + i * 3_600_000);
    const coords = new CoordinateSystem();
    coords.setSize(300, 400, 1);
    coords.setBars(times);
    coords.setViewport({ barSpacing: 5, rightOffset: 0 });
    const s = new SceneGraph();
    const price = s.ensurePane('price', 'price', 0, 3);
    price.bounds = { top: 0, height: 400 };
    price.scale = { min: 100, max: 200 };
    s.bars = times.map((time) => ({ time, open: 150, high: 160, low: 140, close: lastClose, volume: 1 }));
    s.showCountdown = false;
    s.style = { ...s.style, sessions: { ...s.style.sessions, extendedPriceLine: lineOn } };
    s.extendedPrice = extendedPrice;
    const rec = chromeRecorder();
    const chrome = new ChromeRenderer();
    chrome.mount(rec.canvas);
    chrome.render(s, coords, DARK_THEME);
    return rec;
}

describe('chrome extended-hours price', () => {
    it('paints a pre-market line, tag, and axis chip in the pre-market color', () => {
        const { strokes, fills, texts } = paintChrome({ price: 120, session: 'pre' });
        const y = 0.5 + Math.round(400 * (1 - (120 - 100) / 100)); // 320.5
        expect(strokes).toContainEqual({ color: SESSION_PRE, y });
        expect(texts.some((t) => t.text === 'Pre-market' && t.color === SESSION_PRE)).toBe(true);
        expect(fills.some((f) => f.color === SESSION_PRE && f.x === 301 && f.y === 312 && f.h === 16)).toBe(true);
        expect(texts.some((t) => t.text.startsWith('120'))).toBe(true);
    });

    it('post-market wears the post-market color', () => {
        const { strokes, texts } = paintChrome({ price: 120, session: 'post' });
        expect(strokes.some((s) => s.color === SESSION_POST)).toBe(true);
        expect(texts.some((t) => t.text === 'Post-market')).toBe(true);
    });

    it('the chip steps clear of the last-price chip when the levels collide', () => {
        const { fills } = paintChrome({ price: 155.5, session: 'post' }, true, 155);
        const lastY = 400 * (1 - 55 / 100); // 180
        const chip = fills.find((f) => f.color === SESSION_POST && f.h === 16)!;
        expect(chip.y + 16 <= lastY - 8 || chip.y >= lastY + 8).toBe(true);
    });

    it('nothing paints when the line is switched off or there is no price', () => {
        for (const rec of [paintChrome({ price: 120, session: 'pre' }, false), paintChrome(null)]) {
            expect(rec.strokes.some((s) => s.color === SESSION_PRE)).toBe(false);
            expect(rec.texts.some((t) => t.text === 'Pre-market')).toBe(false);
        }
    });
});

describe('extendedPriceLine config', () => {
    it('defaults on, merges off, and round-trips through the renderer config', () => {
        expect(defaultChartStyle().sessions.extendedPriceLine).toBe(true);
        const r = new NativeRenderer();
        const base = r.getConfig() as ChartConfig;
        expect(base.sessions.extendedPriceLine).toBe(true);
        expect(mergeConfig(base, { sessions: { extendedPriceLine: false } }).sessions.extendedPriceLine).toBe(false);
        expect(mergeConfig(base, { sessions: { extendedPriceLine: 'no' } }).sessions.extendedPriceLine).toBe(true);
        r.applyConfig({ sessions: { extendedPriceLine: false } });
        expect((r.getConfig() as ChartConfig).sessions).toMatchObject({ extendedPriceLine: false, premarketColor: base.sessions.premarketColor });
    });

    it('the renderer accepts a valid price and drops malformed ones', () => {
        const r = new NativeRenderer();
        expect(r.features).toContain('extendedPrice');
        r.applyFeature('extendedPrice', { price: 12.5, session: 'pre' });
        expect(r.readFeature('extendedPrice')).toEqual({ price: 12.5, session: 'pre' });
        r.applyFeature('extendedPrice', { price: 'x', session: 'pre' });
        expect(r.readFeature('extendedPrice')).toBeNull();
        r.applyFeature('extendedPrice', { price: 1, session: 'overnight' });
        expect(r.readFeature('extendedPrice')).toBeNull();
    });
});
