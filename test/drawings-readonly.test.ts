// View-only drawings and host selection actions: the core refuses every user edit on a
// read-only chart (whatever the renderer sends), keeps the host's own API working, and
// offers the host's actions for exactly the selections they apply to.
import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../src/core/events/EventBus';
import type { VelaEventMap } from '../src/core/events/types';
import { DrawingController } from '../src/core/drawings/DrawingController';
import { buildToolbar, type DrawingActionView, type DrawingIntent, type IDrawingsRendererPort, type SerializedDrawing } from '../src/core/drawings';
import type { IChartRenderer } from '../src/core/ports/IChartRenderer';

class Port implements IDrawingsRendererPort {
    synced: SerializedDrawing[] = [];
    visible: boolean | null = null;
    tool: string | null = null;
    readOnly: boolean | null = null;
    actions: DrawingActionView[][] = [];
    selection: string[] = [];
    private cb: ((i: DrawingIntent) => void) | null = null;
    setToolbar(): void {}
    showToolbar(v: boolean): void {
        this.visible = v;
    }
    syncDrawings(docs: readonly SerializedDrawing[]): void {
        this.synced = [...docs];
    }
    setActiveTool(t: string | null): void {
        this.tool = t;
    }
    setSelection(ids: readonly string[]): void {
        this.selection = [...ids];
    }
    setReadOnly(on: boolean): void {
        this.readOnly = on;
    }
    setSelectionActions(a: readonly DrawingActionView[]): void {
        this.actions.push([...a]);
    }
    openSettings(): void {}
    onDrawingIntent(cb: (i: DrawingIntent) => void): () => void {
        this.cb = cb;
        return () => (this.cb = null);
    }
    fire(i: DrawingIntent): void {
        this.cb?.(i);
    }
}

function setup(option: Parameters<typeof buildToolbar>[0] = { readOnly: true }) {
    const port = new Port();
    const events = new TypedEventBus<VelaEventMap>();
    const renderer = { capabilities: { userDrawings: true }, userDrawingsPort: port } as unknown as IChartRenderer;
    const ctrl = new DrawingController(renderer, events, option);
    return { port, ctrl, events };
}

const box = (id: string): SerializedDrawing => ({
    id,
    type: 'box',
    paneId: 'price',
    anchors: [
        { time: 1, price: 10 },
        { time: 2, price: 5 },
    ],
    style: { lineColor: '#fff', lineWidth: 1, lineStyle: 'solid' },
    locked: false,
    visible: true,
    zIndex: 0,
    createdAt: 0,
});

describe('view-only drawings', () => {
    it('starts hidden-toolbar and view-only from the option, and tells the renderer', () => {
        const { port, ctrl } = setup();
        expect(port.visible).toBe(false);
        expect(port.readOnly).toBe(true);
        expect(ctrl.isReadOnly()).toBe(true);
    });

    it('refuses every user edit the renderer reports, and puts the renderer back', () => {
        const { port, ctrl } = setup();
        const d = ctrl.add('box', { anchors: box('x').anchors })!;
        const before = JSON.stringify(ctrl.toJSON());
        const moved = { ...d.serialize(), anchors: [{ time: 1, price: 20 }, { time: 2, price: 15 }] };
        port.synced = [];
        for (const i of [
            { kind: 'edit', doc: moved },
            { kind: 'edit-many', docs: [moved] },
            { kind: 'delete', ids: [d.id] },
            { kind: 'create', doc: box('new') },
            { kind: 'duplicate', ids: [d.id] },
            { kind: 'reorder', id: d.id, to: 'front' },
            { kind: 'paste' },
            { kind: 'undo' },
        ] as DrawingIntent[]) {
            port.fire(i);
        }
        expect(JSON.stringify(ctrl.toJSON())).toBe(before);
        // The refused edit re-pushed the authoritative drawings.
        expect(port.synced.map((s) => s.anchors[0]!.price)).toEqual([10]);
        port.fire({ kind: 'arm', type: 'trendline' });
        expect(ctrl.getTool()).toBeNull();
        expect(port.tool).toBeNull();
    });

    it('keeps the host API working, but not undo', () => {
        const { ctrl } = setup();
        const d = ctrl.add('box', { anchors: box('x').anchors })!;
        ctrl.update(d.id, { anchors: [{ time: 1, price: 30 }, { time: 2, price: 25 }] });
        expect(ctrl.all().find((x) => x.id === d.id)?.anchors[0]!.price).toBe(30);
        expect(ctrl.canUndo()).toBe(false);
        ctrl.undo();
        expect(ctrl.all().find((x) => x.id === d.id)?.anchors[0]!.price).toBe(30);
        ctrl.setTool('trendline');
        expect(ctrl.getTool()).toBeNull();
    });

    it('lets the user select, and turns off and on at runtime', () => {
        const { port, ctrl } = setup({ readOnly: false });
        const d = ctrl.add('box', { anchors: box('x').anchors })!;
        ctrl.setTool('trendline');
        ctrl.setReadOnly(true);
        expect(ctrl.getTool()).toBeNull();
        expect(port.readOnly).toBe(true);
        port.fire({ kind: 'select', ids: [d.id] });
        expect(port.selection).toEqual([d.id]);
        ctrl.setReadOnly(false);
        port.fire({ kind: 'delete', ids: [d.id] });
        expect(ctrl.all()).toHaveLength(0);
    });

    it('never locks drawings by itself', () => {
        vi.useFakeTimers();
        try {
            const { ctrl } = setup({ readOnly: true, autoLock: 10 });
            const d = ctrl.add('box', { anchors: box('x').anchors })!;
            vi.advanceTimersByTime(100);
            expect(ctrl.all().find((x) => x.id === d.id)?.locked).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]!;

describe('selection actions', () => {
    it('offers each action for the selections it applies to, and runs it with the selected drawings', () => {
        const { port, ctrl } = setup();
        const a = ctrl.add('box', { anchors: box('a').anchors })!;
        const t = ctrl.add('trendline', { anchors: box('t').anchors })!;
        const ran: string[][] = [];
        ctrl.setSelectionActions([
            { id: 'copy', label: 'Copy to my chart', icon: 'copy', run: (docs) => ran.push(docs.map((d) => d.type)) },
            { id: 'boxes', label: 'Boxes only', when: (docs) => docs.every((d) => d.type === 'box'), run: () => ran.push(['boxes']) },
        ]);
        expect(last(port.actions)).toEqual([]); // nothing selected
        port.fire({ kind: 'select', ids: [a.id] });
        expect(last(port.actions)).toEqual([
            { id: 'copy', label: 'Copy to my chart', icon: 'copy' },
            { id: 'boxes', label: 'Boxes only' },
        ]);
        port.fire({ kind: 'select', ids: [a.id, t.id] });
        expect(last(port.actions).map((x) => x.id)).toEqual(['copy']);
        port.fire({ kind: 'selection-action', id: 'copy', ids: [a.id, t.id] });
        expect(ran).toEqual([['box', 'trendline']]);
        // An unknown action, or drawings that are gone, run nothing.
        port.fire({ kind: 'selection-action', id: 'nope', ids: [a.id] });
        port.fire({ kind: 'selection-action', id: 'copy', ids: ['gone'] });
        expect(ran).toHaveLength(1);
    });
});
