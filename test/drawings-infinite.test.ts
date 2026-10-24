// An infinite drawing runs its sides on to the edges of the chart, so a support or resistance box
// keeps reaching across the chart without being extended by hand. Trend lines and boxes share the
// `style.extendLeft` / `style.extendRight` pair, and the toolbar's infinity toggle sets both.
import { describe, it, expect } from 'vitest';
import { createDrawing, type Box, type TrendLine, type Projector } from '../src/core/drawings';
import { DrawingPainter } from '../src/renderers/native/drawings/DrawingPainter';
import { sharedPaths } from '../src/renderers/native/drawings/DrawingSettingsPopup';
import type { VelaTheme } from '../src/core/options';

/** x = time, y = 100 − price, 200 × 100 px. */
const proj: Projector = {
    xOf: (t) => t,
    yOf: (price, paneId) => (paneId === 'price' ? 100 - price : null),
    pxToPoint: (x, y) => ({ time: x, price: 100 - y }),
    paneIdAtY: () => 'price',
    width: 200,
    height: 100,
};

const theme = { textColor: '#fff', background: '#000', fontFamily: 'sans-serif' } as unknown as VelaTheme;

function box(extend: { extendLeft?: boolean; extendRight?: boolean } = {}): Box {
    return createDrawing('box', {
        id: 'b',
        paneId: 'price',
        anchors: [
            { time: 50, price: 60 },
            { time: 100, price: 40 },
        ],
        style: { lineColor: '#fff', lineWidth: 1, lineStyle: 'solid', ...extend },
    }) as Box;
}

function trend(extend: { extendLeft?: boolean; extendRight?: boolean } = {}): TrendLine {
    return createDrawing('trendline', {
        id: 't',
        paneId: 'price',
        anchors: [
            { time: 50, price: 50 },
            { time: 100, price: 50 },
        ],
        style: { lineColor: '#fff', lineWidth: 1, lineStyle: 'solid', ...extend },
    }) as TrendLine;
}

/** The rectangle the painter strokes for the box, as [x, y, w, h]. */
function strokedRect(d: Box): number[] {
    const rects: number[][] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
        get: (target, key) => {
            if (key === 'strokeRect') return (...r: number[]) => rects.push(r);
            if (key === 'measureText') return () => ({ width: 0 });
            return key in target ? target[key as string] : () => {};
        },
        set: (target, key, value) => {
            target[key as string] = value;
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
    new DrawingPainter().paintAll(ctx, [d], proj, theme);
    return rects[0]!;
}

describe('an infinite box', () => {
    it('a plain box stops at its corners', () => {
        const d = box();
        expect(strokedRect(d)).toEqual([50, 40, 50, 20]);
        expect(d.hitTest(5, 50, proj, 3)).toBe(false);
    });

    it('extended right, its right side runs past the chart edge, so no border shows there', () => {
        const d = box({ extendRight: true });
        expect(strokedRect(d)).toEqual([50, 40, 152, 20]);
        expect(d.hitTest(195, 40, proj, 3)).toBe(true);
        expect(d.hitTest(5, 50, proj, 3)).toBe(false);
    });

    it('extended both ways, it spans the whole chart and can be clicked at both edges', () => {
        const d = box({ extendLeft: true, extendRight: true });
        expect(strokedRect(d)).toEqual([-2, 40, 204, 20]);
        expect(d.hitTest(5, 50, proj, 3)).toBe(true);
        expect(d.hitTest(195, 50, proj, 3)).toBe(true);
    });

    it('still spans the chart when its corners sit off screen, so a support band keeps showing while the chart scrolls', () => {
        const far = createDrawing('box', {
            id: 'far',
            paneId: 'price',
            anchors: [
                { time: 400, price: 60 },
                { time: 500, price: 40 },
            ],
            style: { lineColor: '#fff', lineWidth: 1, lineStyle: 'solid', extendLeft: true, extendRight: true },
        }) as Box;
        expect(strokedRect(far)).toEqual([-2, 40, 204, 20]);
    });

    it('keeps its infinite sides after a save and a reload', () => {
        const saved = JSON.parse(JSON.stringify(box({ extendLeft: true, extendRight: true }).serialize()));
        const restored = createDrawing(saved.type, saved) as Box;
        expect(strokedRect(restored)).toEqual([-2, 40, 204, 20]);
        const line = JSON.parse(JSON.stringify(trend({ extendLeft: true, extendRight: true }).serialize()));
        expect(createDrawing(line.type, line)!.timeExtent()).toBeNull();
    });

    it('is never culled by time, the same as an infinite trend line', () => {
        expect(box().timeExtent()).not.toBeNull();
        expect(box({ extendLeft: true, extendRight: true }).timeExtent()).toBeNull();
        expect(trend({ extendLeft: true, extendRight: true }).timeExtent()).toBeNull();
        expect(trend().timeExtent()).not.toBeNull();
    });

    it('its settings include the extend pair, so the toolbar toggle can edit it', () => {
        const paths = box().schema().fields.map((f) => f.path);
        expect(paths).toContain('style.extendLeft');
        expect(paths).toContain('style.extendRight');
    });

    it('a line and a box in one selection still share the extend pair, so the toggle shows for both', () => {
        const shared = sharedPaths([trend(), box()]);
        expect(shared.has('style.extendLeft')).toBe(true);
        expect(shared.has('style.extendRight')).toBe(true);
    });
});
