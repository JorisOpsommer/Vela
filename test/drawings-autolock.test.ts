import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypedEventBus } from '../src/core/events/EventBus';
import type { VelaEventMap } from '../src/core/events/types';
import { DrawingController } from '../src/core/drawings/DrawingController';
import type { DrawingsOption, IDrawingsRendererPort, DrawingIntent, SerializedDrawing } from '../src/core/drawings';
import type { IChartRenderer } from '../src/core/ports/IChartRenderer';
import { deletableSelection } from '../src/renderers/native/drawings/DrawingHitTester';

/** A renderer port that records what the core pushes down and lets a test fire intents up. */
class FakePort implements Partial<IDrawingsRendererPort> {
    synced: SerializedDrawing[] = [];
    private cb: ((i: DrawingIntent) => void) | null = null;
    setToolbar(): void {}
    showToolbar(): void {}
    syncDrawings(docs: readonly SerializedDrawing[]): void {
        this.synced = [...docs];
    }
    setSelection(): void {}
    onDrawingIntent(cb: (i: DrawingIntent) => void): () => void {
        this.cb = cb;
        return () => {};
    }
    fire(i: DrawingIntent): void {
        this.cb?.(i);
    }
}

const HLINE_DOC: SerializedDrawing = {
    id: 'renderer-temp',
    type: 'hline',
    paneId: 'price',
    anchors: [{ time: 1000, price: 25000 }],
    style: { lineColor: '#fff', lineWidth: 1, lineStyle: 'solid' },
    locked: false,
    visible: true,
    zIndex: 0,
    createdAt: 0,
};

const MINUTE = 60_000;

function setup(option?: DrawingsOption) {
    const port = new FakePort();
    const events = new TypedEventBus<VelaEventMap>();
    const edited: Array<{ id: string; auto?: boolean }> = [];
    events.on('drawing:edited', (e) => edited.push(e));
    const renderer = { capabilities: { userDrawings: true }, userDrawingsPort: port } as unknown as IChartRenderer;
    const ctrl = new DrawingController(renderer, events, option);
    return { port, ctrl, edited };
}

describe('drawing auto-lock', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is on by default, at one minute', () => {
        const { port, ctrl } = setup(true);
        port.fire({ kind: 'create', doc: HLINE_DOC });
        vi.advanceTimersByTime(MINUTE - 1);
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(1);
        expect(ctrl.all()[0]!.locked).toBe(true);
    });

    it('is off when the host sets autoLock to false, or turns drawings off', () => {
        for (const option of [{ autoLock: false }, false] as const) {
            const { port, ctrl } = setup(option);
            port.fire({ kind: 'create', doc: HLINE_DOC });
            vi.advanceTimersByTime(10 * MINUTE);
            expect(ctrl.all()[0]!.locked).toBe(false);
        }
    });

    it('locks an untouched drawing after the idle window, and says the lock was automatic', () => {
        const { port, ctrl, edited } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        vi.advanceTimersByTime(MINUTE - 1);
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(1);
        expect(ctrl.all()[0]!.locked).toBe(true);
        expect(edited[edited.length - 1]).toEqual({ id, auto: true });
        expect(port.synced.find((d) => d.id === id)!.locked).toBe(true); // the renderer is told
    });

    it('restarts the countdown on every touch, through the renderer or the API', () => {
        const { port, ctrl } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        vi.advanceTimersByTime(MINUTE - 10_000);
        port.fire({ kind: 'edit', doc: { ...HLINE_DOC, id, anchors: [{ time: 1, price: 30000 }] } });
        vi.advanceTimersByTime(MINUTE - 10_000);
        expect(ctrl.all()[0]!.locked).toBe(false);
        ctrl.update(id, { style: { lineWidth: 2 } as SerializedDrawing['style'] });
        vi.advanceTimersByTime(MINUTE - 10_000);
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(ctrl.all()[0]!.locked).toBe(true);
    });

    it('pauses while selected and restarts when the selection is released', () => {
        const { port, ctrl } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        ctrl.select([id]);
        vi.advanceTimersByTime(5 * MINUTE);
        expect(ctrl.all()[0]!.locked).toBe(false);
        ctrl.select([]);
        vi.advanceTimersByTime(MINUTE - 1);
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(1);
        expect(ctrl.all()[0]!.locked).toBe(true);
    });

    it('an unlocked drawing locks again only after it is left alone for another minute', () => {
        const { port, ctrl } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        vi.advanceTimersByTime(MINUTE);
        expect(ctrl.all()[0]!.locked).toBe(true);
        ctrl.setLocked(id, false); // the user unlocks it: a touch, so the countdown is armed afresh
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(MINUTE - 1);
        expect(ctrl.all()[0]!.locked).toBe(false);
        vi.advanceTimersByTime(1);
        expect(ctrl.all()[0]!.locked).toBe(true);
    });

    it('a manual lock cancels the countdown and records a normal edit', () => {
        const { port, ctrl, edited } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        ctrl.setLocked(id, true);
        expect(edited[edited.length - 1]).toEqual({ id });
        edited.length = 0;
        vi.advanceTimersByTime(5 * MINUTE);
        expect(edited).toEqual([]); // no second, automatic lock fires
    });

    it('a removed drawing leaves no countdown behind', () => {
        const { port, ctrl, edited } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        ctrl.remove(ctrl.all()[0]!.id);
        vi.advanceTimersByTime(5 * MINUTE);
        expect(edited.filter((e) => e.auto)).toEqual([]);
    });

    it('arms every unlocked drawing of a loaded document, and leaves locked ones alone', () => {
        const { ctrl } = setup({ autoLock: MINUTE });
        ctrl.fromJSON({
            version: 1,
            drawings: [
                { ...HLINE_DOC, id: 'dw-1', locked: false },
                { ...HLINE_DOC, id: 'dw-2', locked: true },
            ],
        });
        vi.advanceTimersByTime(MINUTE);
        expect(ctrl.all().map((d) => [d.id, d.locked])).toEqual([
            ['dw-1', true],
            ['dw-2', true],
        ]);
    });

    it('a drawing locked through the API stays locked (the API is not gated by the lock)', () => {
        const { port, ctrl } = setup({ autoLock: MINUTE });
        port.fire({ kind: 'create', doc: HLINE_DOC });
        const id = ctrl.all()[0]!.id;
        ctrl.update(id, { locked: true });
        vi.advanceTimersByTime(5 * MINUTE);
        expect(ctrl.all()[0]!.locked).toBe(true);
    });
});

describe('locked drawings are protected from delete', () => {
    it('a lone locked drawing is not deletable, alongside unlocked ones in a selection', () => {
        const drawings = [
            { id: 'a', locked: true },
            { id: 'b', locked: false },
        ] as unknown as Parameters<typeof deletableSelection>[1];
        expect(deletableSelection(['a'], drawings)).toEqual([]);
        expect(deletableSelection(['b'], drawings)).toEqual(['b']);
        expect(deletableSelection(['a', 'b'], drawings)).toEqual(['b']);
    });
});
