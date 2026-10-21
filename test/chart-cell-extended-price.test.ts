// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// This jsdom build ships no `CSS` global; the style injector only needs `escape`.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

import { ChartCell, type CellBoot, type CellDeps } from '../src/workspace/ChartCell';
import { MultiProviderFeed } from '../src/data/MultiProviderFeed';
import { BarStore } from '../src/data/BarStore';
import type { DataProvider } from '../src/core/ports/DataProvider';
import type { IChartRenderer, RendererCapabilities, IndicatorRenderHandle, VisibleRange, InputChangeEvent, ClickEvent, CrosshairEvent } from '../src/core/ports/IChartRenderer';
import type { OHLCV } from '../src/core/model/ohlcv';
import type { InputValue } from '../src/core/model/inputs';
import type { IndicatorModel, Pane, ScenePatch } from '../src/core/model';
import type { PriceStyle } from '../src/core/options';
import type { Unsubscribe } from '../src/core/util/types';
import { DARK_THEME } from '../src/core/theme';

/**
 * The pre/post-market price line at the cell seam: a regular-hours chart of a day-split
 * equity gets the extended tape's last price pushed to its renderer; replay, the ETH
 * session, and the config switch take it down; and a config change that turns the switch
 * back on WITHOUT the cell's own settings row (a reset, a template, a style-linked cell)
 * brings it back.
 */

const NY = 'America/New_York';
// August 2026 (EDT = UTC-4): regular 09:30–16:00 ET, extended 04:00–20:00 ET, Mon 10–Fri 14.
const D = (day: number, h: number, m = 0): number => Date.UTC(2026, 7, day, h, m);
const DAYS = [10, 11, 12, 13, 14];
const REGULAR = DAYS.map((d) => [D(d, 13, 30), D(d, 20, 0)] as const);
const EXTENDED = DAYS.map((d) => [D(d, 8, 0), D(d, 24, 0)] as const);
const FRIDAY_POST: OHLCV = { time: D(14, 23, 59), open: 148, high: 148.2, low: 147.9, close: 148.1, volume: 10 };

const HOUR = 3_600_000;
const chartBars = (n: number): OHLCV[] => Array.from({ length: n }, (_, i) => ({ time: D(10, 14) + i * HOUR, open: 100, high: 101, low: 99, close: 100.5, volume: 1 }));

function equityProvider(): DataProvider {
    return {
        getBars: (_t, tf, range) => Promise.resolve(tf === '1' && range.session === 'extended' ? [FRIDAY_POST] : chartBars(range.limit ?? 10)),
        listSymbols: () => Promise.resolve([{ ticker: 'AAPL' }]),
        getSymbolInfo: (ticker) => Promise.resolve({ ticker, session: '0930-1600', session_extended: '0400-2000', timezone: NY }),
        getCalendar: (_t, range) => Promise.resolve(range.session === 'extended' ? EXTENDED : REGULAR),
    };
}

/** A renderer fake that records `extendedPrice` and carries a minimal session config. */
class PriceRenderer implements IChartRenderer {
    readonly capabilities: RendererCapabilities = {
        panes: true,
        paneManagement: false,
        fills: 'primitive',
        bgcolor: 'primitive',
        hline: 'native',
        markers: true,
        barcolor: 'approximated',
        perPointColor: true,
        drawings: true,
        userDrawings: false,
        tables: true,
        inputsUI: true,
    };
    readonly name = 'price-fake';
    readonly features: readonly string[] = ['extendedPrice'];
    extendedPrice: unknown = null;
    lineOn = true;
    private readonly configCbs = new Set<() => void>();
    getConfig(): unknown {
        return { sessions: { extendedPriceLine: this.lineOn } };
    }
    applyConfig(config: unknown): void {
        const v = (config as { sessions?: { extendedPriceLine?: unknown } }).sessions?.extendedPriceLine;
        if (typeof v === 'boolean') this.lineOn = v;
        for (const cb of this.configCbs) cb();
    }
    onConfigChanged(cb: () => void): Unsubscribe {
        this.configCbs.add(cb);
        return () => this.configCbs.delete(cb);
    }
    setSettingsVisibility(): void {}
    setSettingsSections(): void {}
    mount(): void {}
    setTheme(): void {}
    resize(): void {}
    applyFeature(feature: string, value: unknown): void {
        if (feature === 'extendedPrice') this.extendedPrice = value;
    }
    readFeature(feature: string): unknown {
        return feature === 'extendedPrice' ? this.extendedPrice : undefined;
    }
    destroy(): void {}
    setBars(): void {}
    updateBar(): void {}
    ensurePane(_p: Pane): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        return { id: model.id };
    }
    updateIndicator(_h: IndicatorRenderHandle, _p: ScenePatch): void {}
    removeIndicator(): void {}
    setIndicatorInputs(_h: IndicatorRenderHandle, _v: Record<string, InputValue>): void {}
    setIndicatorVisible(): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe {
        return () => {};
    }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe {
        return () => {};
    }
    onToggleIndicatorVisible(_cb: (id: string, visible: boolean) => void): Unsubscribe {
        return () => {};
    }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe {
        return () => {};
    }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe {
        return () => {};
    }
    getVisibleRange(): VisibleRange | null {
        return null;
    }
    setVisibleRange(): void {}
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe {
        return () => {};
    }
    onPriceStyleChange(_cb: (style: PriceStyle) => void): Unsubscribe {
        return () => {};
    }
    setNativeData(): void {}
    setIndicatorStatus(): void {}
}

let lastRenderer: PriceRenderer | null = null;
class TrackedRenderer extends PriceRenderer {
    constructor() {
        super();
        lastRenderer = this;
    }
}

function makeCell(): ChartCell {
    const feed = new MultiProviderFeed(new BarStore());
    void feed.registerProvider('edgx', equityProvider());
    const deps: CellDeps = {
        feed,
        engines: {},
        chartDefaults: { renderer: TrackedRenderer, drawings: false } as CellDeps['chartDefaults'],
        theme: DARK_THEME,
        live: false,
        volume: false,
        statusline: false,
        watermark: false,
        nativeBackend: 'canvas2d',
        dialogHost: document.body,
        timezone: () => 'UTC',
        setTimezone: () => {},
        context: () => ({}) as never,
        manifestSettled: () => true,
        activate: () => {},
        multiCell: () => false,
        isMaximized: () => false,
        toggleMaximize: () => {},
        cellDragTarget: () => null,
        previewDropTarget: () => {},
        dropCell: () => {},
        onMarketChanged: () => {},
        onPriceStyleChanged: () => {},
        onIndicatorsChanged: () => {},
        onStatusPrefsChanged: () => {},
        onStateDirty: () => {},
        toast: () => {},
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    return new ChartCell('c1', host, { symbol: 'edgx:AAPL', timeframe: '60', priceStyle: 'candles' } as CellBoot, deps);
}

const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(() => {
    vi.useRealTimers();
});

describe('ChartCell — pre/post-market price line', () => {
    it('shows the last post-market price on a regular-hours chart over the weekend', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(D(15, 16)); // Sat 12:00 ET
        const cell = makeCell();
        await settle();
        expect(lastRenderer!.extendedPrice).toEqual({ price: 148.1, session: 'post' });
        cell.destroy();
    });

    it('hides during a replay and comes back after it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(D(15, 16));
        const cell = makeCell();
        await settle();
        await cell.chart.replay.start({ from: D(10, 18) });
        expect(lastRenderer!.extendedPrice).toBeNull();
        cell.chart.replay.stop();
        await settle();
        expect(lastRenderer!.extendedPrice).toEqual({ price: 148.1, session: 'post' });
        cell.destroy();
    });

    it('hides on the extended session, where the tape is on the chart itself', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(D(15, 16));
        const cell = makeCell();
        await settle();
        cell.setSession('extended');
        expect(lastRenderer!.extendedPrice).toBeNull();
        cell.setSession('regular');
        await settle();
        expect(lastRenderer!.extendedPrice).toEqual({ price: 148.1, session: 'post' });
        cell.destroy();
    });

    it('follows the config switch, including a re-enable that bypasses the settings row', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(D(15, 16));
        const cell = makeCell();
        await settle();
        const r = lastRenderer!;
        r.applyConfig({ sessions: { extendedPriceLine: false } });
        expect(r.extendedPrice).toBeNull();
        r.applyConfig({ sessions: { extendedPriceLine: true } }); // e.g. Reset defaults
        await settle();
        expect(r.extendedPrice).toEqual({ price: 148.1, session: 'post' });
        cell.destroy();
    });
});
