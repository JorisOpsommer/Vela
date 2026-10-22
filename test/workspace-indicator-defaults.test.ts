// @vitest-environment jsdom
// The colors a user sets on a native indicator are the account's defaults for that type: a fresh
// add starts from them, they ride `getState()`, and they come back on `applyState()`. A restore
// writes stored values into the chart without becoming the defaults, and only color edits count.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// This jsdom build ships no `CSS` global; the style injector only needs `escape`.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };
// jsdom has no ResizeObserver and no Web Animations — the chrome uses both decoratively.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

import { VelaWorkspace } from '../src/workspace/VelaWorkspace';
import type { IndicatorHandle } from '../src/core/IndicatorHandle';

beforeAll(() => {
    Element.prototype.animate ??= (() => ({ cancel() {}, finish() {}, addEventListener() {} })) as unknown as Element['animate'];
});

const live: VelaWorkspace[] = [];
afterEach(() => {
    for (const ws of live.splice(0)) ws.destroy();
});

function mountWorkspace(opts: Record<string, unknown> = {}): VelaWorkspace {
    const host = document.createElement('div');
    document.body.append(host);
    const ws = new VelaWorkspace(host, opts as never);
    live.push(ws);
    return ws;
}

function rsiOf(ws: VelaWorkspace): IndicatorHandle {
    const handle = ws.cell('c1')!.chart.indicators().find((h) => h.nativeType === 'rsi');
    if (!handle) throw new Error('no rsi on c1');
    return handle;
}

function declaredDefault(handle: IndicatorHandle, key: string): unknown {
    return handle.inputs.find((s) => s.key === key)!.defval;
}

const PURPLE = '#9c6ade';
const PINK = '#ec4899';
const RED = '#ef4444';

describe('indicator colors as account defaults', () => {
    it('a re-added RSI starts from the colors the user set on the removed one', () => {
        const ws = mountWorkspace();
        ws.cell('c1')!.addNative('rsi');
        const first = rsiOf(ws);
        first.setInput('color', PURPLE);
        first.setInput('overboughtColor', PINK);
        first.setInput('oversoldColor', RED);
        first.remove();

        ws.cell('c1')!.addNative('rsi');
        const again = rsiOf(ws).inputValues();
        expect(again.color).toBe(PURPLE);
        expect(again.overboughtColor).toBe(PINK);
        expect(again.oversoldColor).toBe(RED);
    });

    it('rides getState and comes back on applyState into a fresh workspace', () => {
        const first = mountWorkspace();
        first.cell('c1')!.addNative('rsi');
        rsiOf(first).setInput('overboughtColor', PINK);
        const saved = JSON.parse(JSON.stringify(first.getState()));
        expect(saved.indicatorDefaults).toEqual({ rsi: { overboughtColor: PINK } });

        const second = mountWorkspace();
        second.applyState(saved);
        expect(JSON.parse(JSON.stringify(second.getState())).indicatorDefaults).toEqual({ rsi: { overboughtColor: PINK } });
        second.cell('c1')!.addNative('rsi');
        expect(rsiOf(second).inputValues().overboughtColor).toBe(PINK);
    });

    it('a restore of a bare rsi keeps the code colors and leaves the account defaults alone', () => {
        const first = mountWorkspace();
        first.cell('c1')!.addNative('rsi');
        rsiOf(first).setInput('overboughtColor', PINK);
        const saved = JSON.parse(JSON.stringify(first.getState()));
        saved.charts[0].indicators = { manifest: [], natives: ['rsi'] };

        const second = mountWorkspace();
        second.applyState(saved);
        const restored = rsiOf(second);
        expect(restored.inputValues().overboughtColor).toBe(declaredDefault(restored, 'overboughtColor'));
        expect(JSON.parse(JSON.stringify(second.getState())).indicatorDefaults).toEqual({ rsi: { overboughtColor: PINK } });
    });

    it('a length edit does not change the remembered colors', () => {
        const ws = mountWorkspace();
        ws.cell('c1')!.addNative('rsi');
        rsiOf(ws).setInput('overboughtColor', PINK);
        rsiOf(ws).setInput('length', 21);
        expect(JSON.parse(JSON.stringify(ws.getState())).indicatorDefaults).toEqual({ rsi: { overboughtColor: PINK } });
    });

    it('setting a color back to its declared default forgets it', () => {
        const ws = mountWorkspace();
        ws.cell('c1')!.addNative('rsi');
        rsiOf(ws).setInput('overboughtColor', PINK);
        rsiOf(ws).setInput('overboughtColor', declaredDefault(rsiOf(ws), 'overboughtColor') as string);
        expect(ws.getState().indicatorDefaults).toBeUndefined();
    });

    it('a workspace that never set a color has no indicator defaults in its state', () => {
        const ws = mountWorkspace();
        ws.cell('c1')!.addNative('rsi');
        expect(ws.getState().indicatorDefaults).toBeUndefined();
    });

    it('a stored document keeps only string color values, and drops empty types', () => {
        const ws = mountWorkspace();
        ws.applyState({
            version: 1,
            layout: '1',
            charts: [{ id: 'c1', symbol: 'SPY', timeframe: 'D', indicators: { manifest: [], natives: [] } }],
            indicatorDefaults: {
                rsi: { overboughtColor: PINK, length: 14, color: 7 },
                '': { color: PURPLE },
                macd: 'nope',
                volume: {},
            },
        });
        expect(ws.getState().indicatorDefaults).toEqual({ rsi: { overboughtColor: PINK } });
    });
});
