// The trends page: the computer's view of the account's watchlist. A view-only chart shows
// the support and resistance boxes and trend lines the server detected on the 4h and Daily
// bars; nothing can be drawn here. Each shape copies to the account's own chart of that
// symbol — from its toolbar on the chart, or from the panel's list.
import { VelaWorkspace } from '../../src/workspace';
import { registerDrawingAction, registerSidePanel, registerWidgetAction, type SidePanelDescriptor, type WidgetContext } from '../../src/plugin';
import { registerIcon, svg16 } from '../../src/ui';
import type { DrawingsDocument, SerializedDrawing } from '../../src';
import { api, ApiError, loadMe } from './lib/api';
import { ServerProvider } from './lib/server-provider';
import { showProviderLimit } from './lib/toast';
import { symbolGlyph } from './lib/symbol-glyph';
import './app.css';
import './trends.css';

type Tf = '240' | 'D';
type Kind = 'support' | 'resistance' | 'trendline-up' | 'trendline-down';

interface Shape {
    id: string;
    kind: Kind;
    tf: Tf;
    anchors: [{ time: number; price: number }, { time: number; price: number }];
    touches: number;
    score: number;
    lastTouch: number;
    status: 'holding' | 'testing' | 'broken';
    confluence?: boolean;
}

interface Signal {
    kind: 'testing-support' | 'testing-resistance' | 'breakout' | 'breakdown' | 'trendline-break' | 'trendline-bounce';
    tf: Tf;
    shapeId: string;
    strength: number;
    at: number;
}

interface Trend {
    state: 'up' | 'down' | 'range';
    strength: number;
}

interface Detection {
    tf: Tf;
    asOf: number;
    close: number;
    trend: Trend;
    shapes: Shape[];
    signals: Signal[];
}

interface Brief {
    asOf: number;
    close: number;
    trend: Trend;
    shapes: number;
    signal: Signal | null;
}

interface Row {
    symbol: string;
    name: string;
    class: string | null;
    D: Brief | null;
    h4: Brief | null;
    top: Signal | null;
}

interface SymbolReads {
    symbol: string;
    name: string;
    reads: Partial<Record<Tf, Detection>>;
    copied: string[];
}

const AUTO = 'auto-';
const COLORS: Record<Kind, string> = { support: '#22ab94', resistance: '#f23645', 'trendline-up': '#2962ff', 'trendline-down': '#ff9800' };
/** Box fills carry their alpha in the color itself. */
const FILLS: Record<'support' | 'resistance', string> = { support: 'rgba(34, 171, 148, 0.12)', resistance: 'rgba(242, 54, 69, 0.12)' };
const KIND_LABEL: Record<Kind, string> = { support: 'Support', resistance: 'Resistance', 'trendline-up': 'Rising trend line', 'trendline-down': 'Falling trend line' };
const SIGNAL_LABEL: Record<Signal['kind'], string> = {
    'testing-support': 'Testing support',
    'testing-resistance': 'Testing resistance',
    breakout: 'Breakout',
    breakdown: 'Breakdown',
    'trendline-break': 'Trend line break',
    'trendline-bounce': 'On its trend line',
};
const TF_LABEL: Record<Tf, string> = { '240': '4h', D: '1D' };
/** Daily shapes show on daily and weekly charts, 4h ones on the intraday ones. */
const SHOW_ON: Record<Tf, string[]> = { D: ['D', 'W'], '240': ['15', '60', '240'] };

registerIcon('app-copy', svg16('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/>'));
registerIcon('app-trends', svg16('<path d="M2 12.5l4-4 3 2.5 5-6"/><path d="M10.5 5H14v3.5"/>'));
registerIcon('app-charts', svg16('<path d="M2.5 13.5h11"/><path d="M4.5 10V6M8 11V3.5M11.5 9V5.5"/>'));

/** `NASDAQ:AAPL` → `AAPL`. */
function bare(s: string): string {
    const i = s.lastIndexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toUpperCase();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtPrice(v: number): string {
    const a = Math.abs(v);
    const d = a < 1 ? 4 : a < 10 ? 3 : 2;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function shapeTitle(s: Shape): string {
    if (s.kind === 'support' || s.kind === 'resistance') return `${KIND_LABEL[s.kind]} ${fmtPrice(s.anchors[1].price)}–${fmtPrice(s.anchors[0].price)}`;
    return KIND_LABEL[s.kind];
}

/** The chart drawing for a detected shape: a box running to the right edge, or a line extended right. */
function toDrawing(s: Shape, z: number): SerializedDrawing {
    const color = COLORS[s.kind];
    const box = s.kind === 'support' || s.kind === 'resistance';
    const label = `${box ? KIND_LABEL[s.kind] : s.kind === 'trendline-up' ? 'Rising line' : 'Falling line'} · ${TF_LABEL[s.tf]} · ${s.touches} touches${s.confluence ? ' · both timeframes' : ''}`;
    return {
        id: `${AUTO}${s.id}`,
        type: box ? 'box' : 'trendline',
        paneId: 'price',
        anchors: s.anchors.map((a) => ({ ...a })),
        style: box
            ? { lineColor: color, lineWidth: s.confluence ? 2 : 1, lineStyle: 'solid', fillColor: FILLS[s.kind as 'support' | 'resistance'], extendRight: true }
            : { lineColor: color, lineWidth: 2, lineStyle: s.status === 'broken' ? 'dashed' : 'solid', extendRight: true },
        text: box ? { value: label, color, size: 'small', hAlign: 'left', vAlign: 'top' } : { value: label, color, size: 'small', hAlign: 'center', vAlign: 'center', place: 'end', side: s.kind === 'trendline-up' ? 'below' : 'above' },
        locked: false,
        visible: true,
        zIndex: z,
        createdAt: 0,
        showOn: SHOW_ON[s.tf],
    };
}

/** What a copy carries to the account's own chart: the drawing as shown, minus its identity
 *  and its timeframe limit — a copy shows on every timeframe of that symbol, so it never
 *  lands out of sight. */
function copyable(d: SerializedDrawing): Record<string, unknown> {
    const { id: _id, locked: _locked, createdAt: _created, zIndex: _z, showOn: _showOn, ...rest } = d;
    return rest;
}

class TrendsView {
    private rows: Row[] = [];
    private reads = new Map<string, SymbolReads>();
    private copied = new Set<string>();
    private current: SymbolReads | null = null;
    private readonly list = el('div', 'tr-list');
    private readonly shapes = el('div', 'tr-shapes');
    private readonly head = el('div', 'tr-head');
    private readonly tfChips = el('div', 'tr-tf');
    private applied = '';
    private wsRef: VelaWorkspace | null = null;

    /** The shell mounts its panels while it is being built, before this view can know it. */
    attach(ws: VelaWorkspace): void {
        this.wsRef = ws;
    }

    private get ws(): VelaWorkspace {
        return this.wsRef!;
    }

    mount(ctx: WidgetContext, body: HTMLElement, slot: HTMLElement): void {
        body.classList.add('tr');
        for (const tf of ['240', 'D'] as const) {
            const b = el('button', 'tr-chip', TF_LABEL[tf]);
            b.type = 'button';
            b.dataset.tf = tf;
            b.title = tf === 'D' ? 'Daily shapes' : '4-hour shapes';
            b.onclick = () => ctx.setTimeframe(tf);
            this.tfChips.append(b);
        }
        slot.append(this.tfChips);
        const listTitle = el('div', 'tr-section', 'Your watchlist');
        const note = el('p', 'tr-note', 'Detected by the server on settled 4h and daily bars. This chart is view only: copy a shape to keep and edit it on your own chart.');
        body.append(this.head, this.shapes, listTitle, this.list, note);
        this.renderList();
    }

    async loadList(): Promise<void> {
        const res = await api<{ rows: Row[] }>('/api/trends');
        const strength = (r: Row) => r.top?.strength ?? -1;
        this.rows = res.rows.sort((a, b) => strength(b) - strength(a));
        this.renderList();
    }

    private renderList(): void {
        const active = bare(this.wsRef?.active?.symbol ?? '');
        this.list.replaceChildren();
        if (this.rows.length === 0) {
            this.list.append(el('div', 'tr-empty', 'Loading your watchlist…'));
            return;
        }
        for (const r of this.rows) {
            const row = el('button', `tr-row${r.symbol === active ? ' active' : ''}`);
            row.type = 'button';
            const ico = el('img', 'tr-ico');
            ico.alt = '';
            ico.src = symbolGlyph({ ticker: r.symbol, type: r.class, description: r.name });
            const name = el('span', 'tr-sym');
            name.append(el('b', '', r.symbol), el('span', 'tr-sig', r.top ? `${SIGNAL_LABEL[r.top.kind]} · ${TF_LABEL[r.top.tf]}` : r.D || r.h4 ? 'No signal' : 'Not read yet'));
            const trends = el('span', 'tr-trends');
            for (const [tf, b] of [['240', r.h4], ['D', r.D]] as const) trends.append(this.trendTag(tf, b?.trend ?? null));
            row.append(ico, name, trends);
            row.onclick = () => this.ws.active.setSymbol(r.symbol);
            this.list.append(row);
        }
    }

    private trendTag(tf: Tf, t: Trend | null): HTMLElement {
        const tag = el('span', `tr-trend ${t?.state ?? 'none'}`);
        const arrow = !t ? '·' : t.state === 'up' ? '▲' : t.state === 'down' ? '▼' : '◆';
        tag.textContent = `${TF_LABEL[tf]} ${arrow}`;
        tag.title = t ? `${TF_LABEL[tf]}: ${t.state === 'range' ? 'range' : `${t.state}trend`} (strength ${Math.round(t.strength * 100)})` : `${TF_LABEL[tf]}: not read yet`;
        return tag;
    }

    /** The active chart moved: bring its symbol's shapes onto it (fetched once per symbol). */
    async follow(): Promise<void> {
        const cell = this.wsRef?.active;
        if (!cell) return;
        const symbol = bare(cell.symbol);
        this.renderList();
        this.syncChips(cell.timeframe);
        if (!symbol) return;
        let reads = this.reads.get(symbol);
        if (!reads) {
            this.head.replaceChildren(el('div', 'tr-empty', `Reading ${symbol}…`));
            this.shapes.replaceChildren();
            try {
                reads = await api<SymbolReads>(`/api/trends/symbol/${encodeURIComponent(symbol)}`);
            } catch (err) {
                this.head.replaceChildren(el('div', 'tr-empty', err instanceof ApiError ? err.message : `Could not read ${symbol}.`));
                return;
            }
            this.reads.set(symbol, reads);
            for (const id of reads.copied) this.copied.add(`${reads.symbol}|${id}`);
        }
        // A newer switch won the race: leave its symbol alone.
        if (bare(this.ws.active.symbol) !== symbol) return;
        this.current = reads;
        const key = `${reads.symbol}|${Object.values(reads.reads).map((d) => d?.asOf).join(',')}`;
        if (this.applied !== key) {
            const shapes = [...(reads.reads.D?.shapes ?? []), ...(reads.reads['240']?.shapes ?? [])];
            const doc: DrawingsDocument = { version: 1, drawings: shapes.map((s, i) => toDrawing(s, i + 1)) };
            this.ws.active.chart.drawings.fromJSON(doc);
            this.applied = key;
        }
        this.renderShapes();
    }

    syncChips(tf: string): void {
        const band: Tf = tf === 'D' || tf === 'W' || tf === 'M' ? 'D' : '240';
        for (const b of this.tfChips.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.tf === band);
    }

    /** The shapes of the timeframe on show, with their copy buttons. */
    renderShapes(): void {
        const r = this.current;
        if (!r) return;
        const tf = this.ws.active.timeframe;
        const band: Tf = tf === 'D' || tf === 'W' || tf === 'M' ? 'D' : '240';
        this.syncChips(tf);
        const d = r.reads[band];
        const head = el('div', 'tr-sym-head');
        const title = el('div', 'tr-sym-title');
        title.append(el('b', '', r.symbol), el('span', '', r.name));
        head.append(title);
        if (d) {
            const t = d.trend;
            const sum = el('div', `tr-summary ${t.state}`);
            sum.textContent = `${TF_LABEL[band]} ${t.state === 'range' ? 'range' : `${t.state}trend`} · close ${fmtPrice(d.close)} · as of ${new Date(d.asOf).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
            head.append(sum);
            if (d.signals[0]) head.append(el('div', 'tr-signal', `${SIGNAL_LABEL[d.signals[0].kind]} — strength ${d.signals[0].strength}`));
        }
        this.head.replaceChildren(head);

        this.shapes.replaceChildren();
        if (!d || d.shapes.length === 0) {
            this.shapes.append(el('div', 'tr-empty', d ? `Nothing stands out on the ${TF_LABEL[band]} chart.` : `Not enough ${TF_LABEL[band]} history yet.`));
            return;
        }
        const all = el('button', 'tr-copy-all', `Copy all ${d.shapes.length} to my ${r.symbol} chart`);
        all.type = 'button';
        all.onclick = () => void this.copy(d.shapes);
        for (const s of [...d.shapes].sort((a, b) => b.score - a.score)) {
            const row = el('div', 'tr-shape');
            const sw = el('i', 'tr-swatch');
            sw.style.background = COLORS[s.kind];
            const text = el('button', 'tr-shape-text');
            text.type = 'button';
            text.title = 'Show it on the chart';
            text.append(el('span', 'tr-shape-title', shapeTitle(s)), el('span', 'tr-shape-meta', `${s.touches} touches · score ${s.score} · ${s.status}${s.confluence ? ' · both timeframes' : ''}`));
            text.onclick = () => this.ws.active.chart.drawings.select(`${AUTO}${s.id}`);
            const done = this.copied.has(`${r.symbol}|${s.id}`);
            const btn = el('button', `tr-copy${done ? ' done' : ''}`, done ? 'Copied' : 'Copy');
            btn.type = 'button';
            btn.title = done ? 'Already on your chart — copy it again' : `Copy to my ${r.symbol} chart`;
            btn.onclick = () => void this.copy([s]);
            row.append(sw, text, btn);
            this.shapes.append(row);
        }
        this.shapes.append(all);
    }

    /** Copy shapes (by their detected id) to the account's own chart of the current symbol. */
    async copy(shapes: readonly Shape[]): Promise<void> {
        const r = this.current;
        if (!r) return;
        const drawings = new Map(this.ws.active.chart.drawings.all().map((d) => [d.id, d]));
        const items = shapes.map((s) => ({ shapeId: s.id, drawing: copyable(drawings.get(`${AUTO}${s.id}`) ?? toDrawing(s, 0)) }));
        await this.send(r.symbol, items);
    }

    /** Copy drawings selected on the chart (the drawing toolbar's action). */
    async copyDrawings(drawings: readonly SerializedDrawing[]): Promise<void> {
        const r = this.current;
        if (!r) return;
        await this.send(
            r.symbol,
            drawings.map((d) => ({ shapeId: d.id.startsWith(AUTO) ? d.id.slice(AUTO.length) : null, drawing: copyable(d) })),
        );
    }

    private async send(symbol: string, shapes: Array<{ shapeId: string | null; drawing: Record<string, unknown> }>): Promise<void> {
        const ctx = this.ws.context();
        try {
            await api('/api/trends/copy', { method: 'POST', body: { symbol, shapes } });
        } catch (err) {
            ctx.toast(err instanceof ApiError ? err.message : 'Could not copy.', 'error');
            return;
        }
        for (const s of shapes) if (s.shapeId) this.copied.add(`${symbol}|${s.shapeId}`);
        ctx.toast(`${shapes.length === 1 ? 'Copied' : `Copied ${shapes.length} shapes`} to your ${symbol} chart`, 'success');
        this.renderShapes();
    }
}

function trendsPanel(view: TrendsView): SidePanelDescriptor {
    return {
        id: 'trends',
        title: 'Detected',
        icon: 'app-trends',
        order: 10,
        width: 320,
        resizable: true,
        minWidth: 260,
        maxWidth: 520,
        mobile: 'bar',
        mount(ctx, body, header) {
            view.mount(ctx, body, header.slot);
            return { onChart: () => void view.follow() };
        },
    };
}

async function main(): Promise<void> {
    const me = await loadMe();
    if (me.mustChangePassword) {
        location.href = '/account';
        return;
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
    const provider = new ServerProvider({ onProviderLimit: showProviderLimit });
    const view = new TrendsView();
    registerSidePanel(trendsPanel(view));
    registerDrawingAction({ id: 'trends-copy', label: 'Copy to my chart', icon: 'app-copy', run: (_ctx, drawings) => void view.copyDrawings(drawings) });
    registerWidgetAction({ id: 'trends-open', target: 'topbar', label: 'Open in my charts', icon: 'app-charts', iconOnly: true, order: 870, run: (ctx) => (location.href = `/?symbol=${encodeURIComponent(bare(ctx.symbol))}`) });

    const linked = new URLSearchParams(location.search).get('symbol');
    const first = linked && /^[A-Za-z0-9.:^=/ -]{1,40}$/.test(linked) ? linked : null;
    const rows = first ? null : await api<{ rows: Row[] }>('/api/trends').catch(() => null);
    const ws = new VelaWorkspace('#app', {
        layout: '1',
        symbol: first ?? rows?.rows.sort((a, b) => (b.top?.strength ?? -1) - (a.top?.strength ?? -1))[0]?.symbol ?? 'SPY',
        timeframe: 'D',
        bars: 1000,
        live: true,
        theme: 'dark',
        timezone,
        autofocus: true,
        mobileSettings: 'menu',
        // View only: the computer's shapes can be selected and copied, never drawn or edited.
        drawings: { readOnly: true },
        providers: { market: () => provider },
    });
    view.attach(ws);
    ws.context().togglePanel('trends', true);
    const refollow = () => void view.follow();
    ws.on('state:changed', refollow);
    ws.on('cell:active', refollow);
    void view.loadList();
    void view.follow();
    (window as unknown as { vela?: unknown }).vela = ws;
}

main().catch((err: unknown) => {
    console.error(err);
    const box = document.getElementById('app');
    if (box) box.innerHTML = '<p class="boot-error">Could not load the page. Reload the page to try again.</p>';
});
