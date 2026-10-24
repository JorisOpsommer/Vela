// Shapes copied from the trends page wait in the account's drawing inbox (the server
// appends to it) until a chart here shows their symbol: then they join that chart's own
// drawings for the symbol — editable and saved like any other — and leave the inbox.
// The active chart takes them first; another chart showing the symbol takes them otherwise.
import type { VelaWorkspace } from '../../../src/workspace';
import type { DrawingTypeKey, SerializedDrawing } from '../../../src';
import type { ServerStorage } from './storage';
import { api } from './api';

export const INBOX_KEY = 'drawing-inbox';

interface Item {
    id: string;
    symbol: string;
    drawing: Partial<SerializedDrawing> & { type: DrawingTypeKey };
}

function items(raw: string | null): Item[] {
    try {
        const d = raw ? (JSON.parse(raw) as { version?: unknown; items?: unknown }) : null;
        return d?.version === 1 && Array.isArray(d.items) ? (d.items as Item[]) : [];
    } catch {
        return [];
    }
}

const bare = (s: string) => s.slice(s.lastIndexOf(':') + 1).trim().toUpperCase();

export function startDrawingInbox(ws: VelaWorkspace, storage: ServerStorage): void {
    /** Placed here but maybe not yet gone from the copy of the inbox this tab holds. */
    const placed = new Set<string>();
    let latest: string | null = null;
    const read = async () => {
        const v = await storage.get(INBOX_KEY);
        latest = typeof v === 'string' ? v : null;
    };
    const drain = () => {
        const waiting = items(latest).filter((i) => !placed.has(i.id));
        if (waiting.length === 0) return;
        const cells = [ws.active, ...ws.cells().filter((c) => c !== ws.active)];
        const took: string[] = [];
        for (const item of waiting) {
            const cell = cells.find((c) => bare(c.symbol) === item.symbol);
            if (!cell) continue;
            const d = item.drawing;
            const added = cell.chart.drawings.add(d.type, { anchors: d.anchors, style: d.style, text: d.text, props: d.props });
            if (added && d.showOn) cell.chart.drawings.update(added.id, { showOn: d.showOn });
            placed.add(item.id);
            took.push(item.id);
        }
        if (took.length === 0) return;
        ws.context().toast(`${took.length === 1 ? 'A shape' : `${took.length} shapes`} from Trends added to this chart`, 'success');
        void api('/api/trends/inbox/claim', { method: 'POST', body: { ids: took } }).catch(() => {
            // Unclaimed items stay in the inbox; `placed` keeps this tab from adding them twice.
        });
    };
    void read().then(drain);
    storage.onRemote(INBOX_KEY, (value) => {
        latest = value;
        drain();
    });
    // A symbol switch, a layout change, a new active chart: any of them may show a waiting symbol.
    ws.on('state:changed', drain);
    ws.on('cell:active', drain);
}
