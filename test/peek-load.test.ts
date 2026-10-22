// Held bars first: a source that already holds bars for a load paints them at once, the
// stretch after the newest held bar is marked provisional, and the real answer replaces
// them in place — or, when it comes back empty, the held bars stay, honestly dated.
import { describe, it, expect } from 'vitest';
import { Vela } from '../src/index';
import type { IChartRenderer, RendererCapabilities, IndicatorRenderHandle, CrosshairEvent, ClickEvent, InputChangeEvent, VisibleRange } from '../src/core/ports/IChartRenderer';
import type { MarketDataFeed } from '../src/core/ports/MarketDataFeed';
import type { PeekedBars } from '../src/core/ports/DataProvider';
import type { MarketConfig, VelaTheme } from '../src/core/options';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { Pane } from '../src/core/model/scene';
import type { IndicatorModel } from '../src/core/model/indicator';
import type { Unsubscribe } from '../src/core/util/types';

const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const T0 = 1_700_000_000_000;
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
const MIN = 60_000;
const bars = (from: number, n: number): OHLCV[] => Array.from({ length: n }, (_, i) => ({ time: T0 + (from + i) * MIN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));

type Provisional = { from: number; asOf: number; status: 'syncing' | 'stale' } | null;

class Renderer implements IChartRenderer {
    readonly capabilities: RendererCapabilities = {
        panes: true, paneManagement: false, fills: 'primitive', bgcolor: 'primitive', hline: 'native',
        markers: true, barcolor: 'approximated', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true,
    };
    readonly name = 'recording';
    readonly features: readonly string[] = [];
    bars: OHLCV[] = [];
    setBarsCalls: Array<{ n: number; preserveView?: boolean }> = [];
    provisional: Array<{ state: Provisional; reveal?: boolean }> = [];
    applyFeature(): void {}
    readFeature(): unknown { return undefined; }
    mount(_c: HTMLElement, _t: VelaTheme): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    setBars(b: OHLCV[], opts?: { preserveView?: boolean }): void {
        this.bars = [...b];
        this.setBarsCalls.push({ n: b.length, preserveView: opts?.preserveView });
    }
    updateBar(bar: OHLCV): void {
        const last = this.bars[this.bars.length - 1];
        if (last && last.time === bar.time) this.bars[this.bars.length - 1] = bar;
        else this.bars.push(bar);
    }
    setProvisional(state: Provisional, opts?: { reveal?: boolean }): void { this.provisional.push({ state, reveal: opts?.reveal }); }
    setNativeData(): void {}
    ensurePane(_p: Pane): void {}
    removePane(_id: string): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle { return { id: model.id }; }
    updateIndicator(): void {}
    removeIndicator(): void {}
    setIndicatorInputs(): void {}
    setIndicatorVisible(): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe { return () => {}; }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe { return () => {}; }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe { return () => {}; }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe { return () => {}; }
    getVisibleRange(): VisibleRange | null { return null; }
    setVisibleRange(_r: VisibleRange): void {}
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe { return () => {}; }
}

/** A slow source that holds older bars: `peek` answers at once, `load` waits for the test. */
class HeldFeed implements MarketDataFeed {
    peeks = 0;
    private release: ((b: OHLCV[]) => void) | null = null;
    constructor(private readonly held: PeekedBars | null) {}
    peek(): Promise<PeekedBars | null> {
        this.peeks += 1;
        return Promise.resolve(this.held);
    }
    load(_cfg: MarketConfig): Promise<OHLCV[]> {
        return new Promise((r) => (this.release = r));
    }
    answer(b: OHLCV[]): void {
        this.release?.(b);
    }
    subscribe(): Unsubscribe {
        return () => {};
    }
}

function chartWith(feed: HeldFeed) {
    const renderer = new Renderer();
    const chart = new Vela({} as unknown as HTMLElement, { bars: 100, live: false }, { renderer, engines: [], dataFeed: feed });
    const events: string[] = [];
    chart.on('data:provisional', (e) => events.push(e.state));
    return { renderer, chart, events };
}

describe('held bars paint before the real load', () => {
    it('paints the held bars at once, marks the rest provisional, then swaps in the real answer on the live edge', async () => {
        const feed = new HeldFeed({ bars: bars(0, 80), asOf: T0 + 79 * MIN });
        const { renderer, events } = chartWith(feed);
        await flush();
        // The real load is still in flight, and the held bars are on screen.
        expect(renderer.bars).toHaveLength(80);
        expect(last(renderer.provisional)?.state).toEqual({ from: T0 + 79 * MIN, asOf: T0 + 79 * MIN, status: 'syncing' });
        expect(events).toEqual(['syncing']);

        feed.answer(bars(0, 100));
        await flush();
        expect(renderer.bars).toHaveLength(100);
        // The swap keeps the frame: newer bars arrive on the right of the same series.
        expect(last(renderer.setBarsCalls)).toEqual({ n: 100, preserveView: true });
        expect(last(renderer.provisional)).toEqual({ state: null, reveal: true });
        expect(events).toEqual(['syncing', 'live']);
    });

    it('keeps the held bars, dated, when the real load comes back empty', async () => {
        const feed = new HeldFeed({ bars: bars(0, 80), asOf: T0 });
        const { renderer, events } = chartWith(feed);
        await flush();
        feed.answer([]);
        await flush();
        expect(renderer.bars).toHaveLength(80);
        expect(last(renderer.provisional)?.state?.status).toBe('stale');
        expect(events).toEqual(['syncing', 'stale']);
    });

    it('paints a complete peek plainly, with no catch-up mark', async () => {
        const feed = new HeldFeed({ bars: bars(0, 100), asOf: T0, complete: true });
        const { renderer, events } = chartWith(feed);
        await flush();
        expect(renderer.bars).toHaveLength(100);
        expect(renderer.provisional).toEqual([]);
        feed.answer(bars(0, 100));
        await flush();
        expect(events).toEqual([]);
    });

    it('ignores a peek that lands after the real answer', async () => {
        let resolvePeek: (p: PeekedBars) => void = () => {};
        const feed = new HeldFeed(null);
        feed.peek = () => new Promise((r) => (resolvePeek = r));
        const { renderer } = chartWith(feed);
        await flush();
        feed.answer(bars(0, 100));
        await flush();
        resolvePeek({ bars: bars(0, 50), asOf: T0 });
        await flush();
        expect(renderer.bars).toHaveLength(100);
        expect(renderer.provisional).toEqual([]);
    });
});
