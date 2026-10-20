// Reports what the signed-in user looks at (symbol opens, timeframes, indicators, chart
// time) to this app's own server, which builds the Insights page from it. Nothing leaves
// the server. Events are batched and sent every few seconds.
import type { VelaWorkspace, WorkspaceState } from '../../../src/workspace';
import { api } from './api';

type Kind = 'open' | 'tf' | 'ind' | 'style' | 'layout' | 'watch' | 'wl';

interface Event {
    k: Kind;
    v: string;
    x?: string;
    n?: number;
    t: number;
}

interface CellSnap {
    symbol: string;
    timeframe: string;
    style: string;
    indicators: Set<string>;
}

const FLUSH_MS = 15_000;
const WATCH_TICK_MS = 60_000;

const queue: Event[] = [];

export function bare(s: string): string {
    const i = s.lastIndexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toUpperCase();
}

export function track(k: Kind, v: string, extra?: { x?: string; n?: number }): void {
    if (!v) return;
    queue.push({ k, v: v.slice(0, 40), ...(extra?.x ? { x: extra.x } : {}), ...(extra?.n != null ? { n: extra.n } : {}), t: Date.now() });
    if (queue.length > 300) queue.splice(0, queue.length - 300);
}

function flush(keepalive = false): void {
    if (queue.length === 0) return;
    const events = queue.splice(0, queue.length);
    void api('/api/analytics/events', { method: 'POST', body: { events }, keepalive, redirectOn401: false }).catch(() => {
        // Lost analytics are acceptable; never retry-loop.
    });
}

function indicatorKeys(cell: WorkspaceState['charts'][number]): Set<string> {
    const out = new Set<string>();
    for (const n of cell.indicators?.natives ?? []) out.add(typeof n === 'string' ? n : n.type);
    for (const m of cell.indicators?.manifest ?? []) out.add(typeof m === 'string' ? m : m.name);
    return out;
}

function snapshot(state: WorkspaceState): { layout: string; active: string | undefined; cells: Map<string, CellSnap> } {
    const cells = new Map<string, CellSnap>();
    for (const c of state.charts) {
        cells.set(c.id, { symbol: bare(c.symbol ?? ''), timeframe: c.timeframe ?? '', style: c.priceStyle ?? '', indicators: indicatorKeys(c) });
    }
    return { layout: state.layout, active: state.activeCellId ?? state.charts[0]?.id, cells };
}

/** Follow the workspace and report changes as events. */
export function startTracker(ws: VelaWorkspace): void {
    let prev = snapshot(ws.getState());
    const first = prev.cells.get(prev.active ?? '');
    if (first?.symbol) track('open', first.symbol, { x: first.timeframe });

    ws.on('state:changed', () => {
        const next = snapshot(ws.getState());
        if (next.layout !== prev.layout) track('layout', next.layout);
        for (const [id, c] of next.cells) {
            const p = prev.cells.get(id);
            if (!p) {
                if (c.symbol) track('open', c.symbol, { x: c.timeframe });
                continue;
            }
            if (c.symbol && c.symbol !== p.symbol) track('open', c.symbol, { x: c.timeframe });
            else if (c.timeframe && c.timeframe !== p.timeframe) track('tf', c.timeframe);
            if (c.style && c.style !== p.style) track('style', c.style);
            for (const ind of c.indicators) if (!p.indicators.has(ind)) track('ind', ind);
        }
        prev = next;
    });

    // Screen time: one minute per minute the page is visible, on the active chart.
    setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const cell = prev.cells.get(ws.getState().activeCellId ?? prev.active ?? '');
        if (cell?.symbol) track('watch', cell.symbol, { x: cell.timeframe, n: 1 });
    }, WATCH_TICK_MS);

    setInterval(() => flush(), FLUSH_MS);
    window.addEventListener('pagehide', () => flush(true));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush(true);
    });
}
