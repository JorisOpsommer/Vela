import { Drawing, type AnchorSlot } from '../Drawing';
import type { Projector } from '../geometry';
import type { SettingsSchema } from '../schema';
import { LINE_FIELDS, TEXT_FIELDS } from '../schema';
import { distToSegment, handleAt, pointInBox } from '../hittest';

/** A rectangle defined by two opposite corners. Optional fill + border. An extended side runs
 *  on to the chart edge, so a box can stand as an infinite support or resistance band. */
export class Box extends Drawing {
    readonly type = 'box' as const;

    anchorSchema(): { min: number; max: number; slots: AnchorSlot[] } {
        return { min: 2, max: 2, slots: [{ role: 'c1', free: 'both' }, { role: 'c2', free: 'both' }] };
    }

    private rect(proj: Projector): { x1: number; y1: number; x2: number; y2: number } | null {
        const a = this.anchors[0];
        const b = this.anchors[1];
        if (!a || !b) return null;
        const ya = proj.yOf(a.price, this.paneId);
        const yb = proj.yOf(b.price, this.paneId);
        if (ya == null || yb == null) return null;
        return { x1: proj.xOf(a.time), y1: ya, x2: proj.xOf(b.time), y2: yb };
    }

    /** The box as painted: its corners, with an extended side pushed out to the chart edge. The
     *  edge sits just past the plot so the border never shows along the chart's sides. */
    frame(proj: Projector): { x: number; y: number; w: number; h: number } | null {
        const r = this.rect(proj);
        if (!r) return null;
        const x1 = this.style.extendLeft ? -2 : Math.min(r.x1, r.x2);
        const x2 = this.style.extendRight ? proj.width + 2 : Math.max(r.x1, r.x2);
        const y1 = Math.min(r.y1, r.y2);
        const y2 = Math.max(r.y1, r.y2);
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    hitTest(px: number, py: number, proj: Projector, tol: number): boolean {
        const f = this.frame(proj);
        if (!f) return false;
        const x1 = f.x;
        const y1 = f.y;
        const x2 = f.x + f.w;
        const y2 = f.y + f.h;
        // A filled box is grabbable anywhere inside; otherwise only near its border.
        if (this.style.fillColor && pointInBox(px, py, x1, y1, x2, y2)) return true;
        const edges: Array<[number, number, number, number]> = [
            [x1, y1, x2, y1],
            [x2, y1, x2, y2],
            [x2, y2, x1, y2],
            [x1, y2, x1, y1],
        ];
        return edges.some((e) => distToSegment(px, py, e[0], e[1], e[2], e[3]) <= tol);
    }

    handlePoints(proj: Projector): Array<[number, number]> {
        const r = this.rect(proj);
        return r ? [[r.x1, r.y1], [r.x2, r.y2]] : [];
    }

    hitHandle(px: number, py: number, proj: Projector, tol: number): number {
        return handleAt(px, py, this.handlePoints(proj), tol + 3);
    }

    bounds(proj: Projector): { x: number; y: number; w: number; h: number } | null {
        const r = this.rect(proj);
        if (!r) return null;
        return { x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) };
    }

    priceRange(): { min: number; max: number } | null {
        const a = this.anchors[0];
        const b = this.anchors[1];
        if (!a || !b) return null;
        return { min: Math.min(a.price, b.price), max: Math.max(a.price, b.price) };
    }

    // An extended side runs to the chart edge → never cull by time.
    override timeExtent(): { min: number; max: number } | null {
        return this.style.extendLeft || this.style.extendRight ? null : super.timeExtent();
    }

    schema(): SettingsSchema {
        return {
            fields: [
                ...LINE_FIELDS.map((f) => ({ ...f, label: f.label.replace('Line', 'Border') })),
                { path: 'style.extendLeft', label: 'Extend left', kind: 'boolean', group: 'line' },
                { path: 'style.extendRight', label: 'Extend right', kind: 'boolean', group: 'line' },
                { path: 'style.fillColor', label: 'Fill color', kind: 'color', group: 'fill' },
                ...TEXT_FIELDS,
            ],
        };
    }
}
