// Contributed drawing actions: the registry, and the projection a shell hands each chart.
import { afterEach, describe, expect, it } from 'vitest';
import { drawingActions, registerDrawingAction, unregisterDrawingAction, type WidgetContext } from '../src/plugin';
import { drawingActionsFor } from '../src/widget/contributions';
import type { SerializedDrawing } from '../src';

const doc = (type: SerializedDrawing['type']) => ({ id: type, type }) as SerializedDrawing;

afterEach(() => {
    for (const a of drawingActions()) unregisterDrawingAction(a.id);
});

describe('drawing actions', () => {
    it('sorts by order, replaces by id, and unregisters with the disposer', () => {
        registerDrawingAction({ id: 'b', label: 'B', order: 2, run: () => {} });
        const off = registerDrawingAction({ id: 'a', label: 'A', order: 1, run: () => {} });
        registerDrawingAction({ id: 'b', label: 'B2', order: 0, run: () => {} });
        expect(drawingActions().map((a) => a.label)).toEqual(['B2', 'A']);
        off();
        expect(drawingActions().map((a) => a.id)).toEqual(['b']);
    });

    it('binds the gate and the run to a context built at each call', () => {
        let n = 0;
        const context = () => ({ symbol: `S${++n}` }) as unknown as WidgetContext;
        const seen: string[] = [];
        registerDrawingAction({
            id: 'copy',
            label: 'Copy',
            icon: 'copy',
            when: (drawings) => drawings.every((d) => d.type === 'box'),
            run: (ctx, drawings) => seen.push(`${ctx.symbol}:${drawings.length}`),
        });
        const [action] = drawingActionsFor(context);
        expect(action).toMatchObject({ id: 'copy', label: 'Copy', icon: 'copy' });
        expect(action!.when!([doc('box')])).toBe(true);
        expect(action!.when!([doc('box'), doc('trendline')])).toBe(false);
        action!.run([doc('box')]);
        action!.run([doc('box'), doc('box')]);
        expect(seen).toEqual(['S3:1', 'S4:2']);
    });
});
