// The watchlist side panel: grouped symbols with live last price and change, saved per
// account. Clicking a row loads it in the active chart.
import type { SidePanelDescriptor, WidgetContext } from '../../src/plugin';
import type { SymbolDescriptor } from '../../src';
import { api } from './lib/api';
import type { ServerStorage } from './lib/storage';
import type { ServerProvider } from './lib/server-provider';
import { track } from './lib/tracker';

export interface WatchGroup {
    name: string;
    symbols: string[];
    collapsed?: boolean;
}

interface WatchDoc {
    version: 1;
    groups: WatchGroup[];
}

interface QuoteRow {
    symbol: string;
    price: number;
    change: number | null;
    changePct: number | null;
    time: number;
}

const STORAGE_KEY = 'watchlist';
const REFRESH_MS = 10_000;

/** `NASDAQ:AAPL` / `market:aapl` → `AAPL`. */
export function bareSymbol(s: string): string {
    const i = s.lastIndexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toUpperCase();
}

export function formatPrice(symbol: string, price: number): string {
    const abs = Math.abs(price);
    const decimals = symbol === 'EURUSD' ? 5 : abs < 0.1 ? 6 : abs < 10 ? 4 : 2;
    return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function parseDoc(raw: string | null): WatchDoc | null {
    if (!raw) return null;
    try {
        const d = JSON.parse(raw) as WatchDoc;
        if (d?.version !== 1 || !Array.isArray(d.groups)) return null;
        const groups = d.groups
            .filter((g) => g && typeof g.name === 'string' && Array.isArray(g.symbols))
            .map((g) => ({ name: g.name.slice(0, 60), symbols: g.symbols.filter((s) => typeof s === 'string').map(bareSymbol).slice(0, 200), collapsed: g.collapsed === true }));
        return { version: 1, groups };
    } catch {
        return null;
    }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function watchlistPanel(storage: ServerStorage, provider: ServerProvider): SidePanelDescriptor {
    return {
        id: 'watchlist',
        title: 'Watchlist',
        icon: 'app-watchlist',
        order: 10,
        width: 300,
        resizable: true,
        minWidth: 240,
        maxWidth: 520,
        // Phones: a one-tap stop on the bottom bar instead of a row in the three-dots menu.
        mobile: 'bar',
        mount(ctx: WidgetContext, body: HTMLElement, header) {
            return new WatchlistView(ctx, body, header.slot, storage, provider).handle();
        },
    };
}

class WatchlistView {
    private doc: WatchDoc = { version: 1, groups: [] };
    private quotes = new Map<string, QuoteRow>();
    private names = new Map<string, SymbolDescriptor>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly list = el('div', 'wl-list');
    private readonly search = el('input', 'wl-search');
    private readonly suggest = el('div', 'wl-suggest');
    private readonly groupSelect = el('select', 'wl-group-select');
    private lastActive = '';

    constructor(
        private readonly ctx: WidgetContext,
        private readonly body: HTMLElement,
        slot: HTMLElement,
        private readonly storage: ServerStorage,
        private readonly provider: ServerProvider,
    ) {
        body.classList.add('wl');
        const resetBtn = el('button', 'wl-icon-btn', '⟲');
        resetBtn.title = 'Restore the default watchlist';
        resetBtn.onclick = () => void this.reset();
        const newGroupBtn = el('button', 'wl-icon-btn', '＋');
        newGroupBtn.title = 'New group';
        newGroupBtn.onclick = () => this.newGroup();
        slot.append(newGroupBtn, resetBtn);

        const addRow = el('div', 'wl-add');
        this.search.placeholder = 'Add symbol…';
        this.search.spellcheck = false;
        this.search.autocomplete = 'off';
        this.search.oninput = () => this.renderSuggest();
        this.search.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const first = this.suggest.querySelector<HTMLElement>('.wl-suggest-row');
                this.add(first?.dataset.symbol ?? this.search.value);
            } else if (e.key === 'Escape') {
                this.search.value = '';
                this.renderSuggest();
            }
            e.stopPropagation();
        };
        this.search.onblur = () => setTimeout(() => (this.suggest.hidden = true), 150);
        this.suggest.hidden = true;
        addRow.append(this.search, this.groupSelect, this.suggest);

        body.append(addRow, this.list);
        void this.load();
        void provider.listSymbols().then((rows) => {
            for (const r of rows) this.names.set(r.ticker.toUpperCase(), r);
            this.render();
        });
    }

    handle() {
        return {
            onChart: () => this.markActive(),
            onOpen: () => {
                this.render();
                void this.refresh();
            },
            destroy: () => {
                if (this.timer) clearInterval(this.timer);
            },
        };
    }

    private async load(): Promise<void> {
        let doc = parseDoc((await this.storage.get(STORAGE_KEY)) as string | null);
        if (!doc) doc = await this.defaults();
        this.doc = doc;
        this.render();
        void this.refresh();
        this.timer = setInterval(() => {
            if (document.visibilityState === 'visible' && this.body.isConnected && this.body.offsetParent !== null) void this.refresh();
            this.markActive();
        }, REFRESH_MS);
    }

    private async defaults(): Promise<WatchDoc> {
        const r = await api<{ groups: WatchGroup[] }>('/api/watchlist/defaults');
        return { version: 1, groups: r.groups.map((g) => ({ name: g.name, symbols: g.symbols })) };
    }

    private save(): void {
        this.storage.set(STORAGE_KEY, JSON.stringify(this.doc));
    }

    private allSymbols(): string[] {
        return [...new Set(this.doc.groups.flatMap((g) => g.symbols))];
    }

    private async refresh(): Promise<void> {
        const syms = this.allSymbols();
        if (syms.length === 0) return;
        try {
            const r = await api<{ quotes: QuoteRow[] }>(`/api/quotes?symbols=${encodeURIComponent(syms.join(','))}`);
            for (const q of r.quotes) {
                const prev = this.quotes.get(q.symbol);
                this.quotes.set(q.symbol, q);
                this.paintQuote(q, prev);
            }
        } catch {
            // Keep the last prices on a transient failure.
        }
    }

    private paintQuote(q: QuoteRow, prev?: QuoteRow): void {
        for (const row of this.list.querySelectorAll<HTMLElement>(`.wl-row[data-symbol="${CSS.escape(q.symbol)}"]`)) {
            const last = row.querySelector<HTMLElement>('.wl-last')!;
            const chg = row.querySelector<HTMLElement>('.wl-chg')!;
            last.textContent = formatPrice(q.symbol, q.price);
            chg.textContent = q.changePct == null ? '—' : `${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
            row.classList.toggle('up', (q.changePct ?? 0) > 0);
            row.classList.toggle('down', (q.changePct ?? 0) < 0);
            if (prev && prev.price !== q.price) {
                last.classList.remove('flash-up', 'flash-down');
                void last.offsetWidth;
                last.classList.add(q.price > prev.price ? 'flash-up' : 'flash-down');
            }
        }
    }

    private markActive(): void {
        const active = bareSymbol(this.ctx.symbol ?? '');
        if (active === this.lastActive) return;
        this.lastActive = active;
        for (const row of this.list.querySelectorAll<HTMLElement>('.wl-row')) row.classList.toggle('active', row.dataset.symbol === active);
    }

    private render(): void {
        this.groupSelect.replaceChildren(...this.doc.groups.map((g, i) => Object.assign(el('option', '', g.name), { value: String(i) })));
        this.groupSelect.title = 'Group to add to';
        const frag = document.createDocumentFragment();
        this.doc.groups.forEach((g, gi) => {
            const head = el('div', 'wl-group');
            const caret = el('span', 'wl-caret', g.collapsed ? '▸' : '▾');
            const name = el('span', 'wl-group-name', g.name);
            const count = el('span', 'wl-count', String(g.symbols.length));
            const menu = el('span', 'wl-group-actions');
            const ren = el('button', 'wl-mini', '✎');
            ren.title = 'Rename group';
            ren.onclick = (e) => {
                e.stopPropagation();
                const n = prompt('Group name', g.name)?.trim();
                if (n) {
                    g.name = n.slice(0, 60);
                    this.save();
                    this.render();
                }
            };
            const del = el('button', 'wl-mini', '✕');
            del.title = 'Delete group';
            del.onclick = (e) => {
                e.stopPropagation();
                if (g.symbols.length && !confirm(`Delete "${g.name}" and its ${g.symbols.length} symbols?`)) return;
                this.doc.groups.splice(gi, 1);
                this.save();
                this.render();
            };
            menu.append(ren, del);
            head.append(caret, name, count, menu);
            head.onclick = () => {
                g.collapsed = !g.collapsed;
                this.save();
                this.render();
            };
            frag.append(head);
            if (g.collapsed) return;
            g.symbols.forEach((sym, si) => frag.append(this.row(sym, gi, si)));
        });
        this.list.replaceChildren(frag);
        this.lastActive = '';
        this.markActive();
        for (const q of this.quotes.values()) this.paintQuote(q);
    }

    private row(sym: string, gi: number, si: number): HTMLElement {
        const d = this.names.get(sym);
        const row = el('div', 'wl-row');
        row.dataset.symbol = sym;
        row.tabIndex = 0;
        const icon = el('span', 'wl-ico');
        const iconUrl = d ? this.provider.resolveSymbolIcon(d) : undefined;
        if (iconUrl) {
            const img = el('img');
            img.alt = '';
            img.loading = 'lazy';
            img.src = iconUrl;
            img.onerror = () => {
                img.remove();
                icon.textContent = sym.slice(0, 1);
            };
            icon.append(img);
        } else {
            icon.textContent = sym.slice(0, 1);
        }
        const label = el('span', 'wl-label');
        label.append(el('span', 'wl-sym', sym), el('span', 'wl-name', d?.description ?? ''));
        const last = el('span', 'wl-last', '—');
        const chg = el('span', 'wl-chg', '');
        const rm = el('button', 'wl-remove', '✕');
        rm.title = 'Remove from watchlist';
        rm.onclick = (e) => {
            e.stopPropagation();
            this.doc.groups[gi]!.symbols.splice(si, 1);
            this.save();
            this.render();
        };
        row.append(icon, label, last, chg, rm);
        const open = () => {
            this.ctx.setSymbol(d?.prefix ? `${d.prefix}:${sym}` : sym);
            // On a phone the panel covers the chart: get out of the way once a symbol is picked.
            if (this.ctx.host.closest('[data-layout="mobile"]')) this.ctx.togglePanel('watchlist', false);
            setTimeout(() => this.markActive(), 50);
        };
        row.onclick = open;
        row.onkeydown = (e) => {
            if (e.key === 'Enter') open();
        };
        return row;
    }

    private renderSuggest(): void {
        const q = this.search.value.trim().toUpperCase();
        if (!q) {
            this.suggest.hidden = true;
            return;
        }
        const hits: SymbolDescriptor[] = [];
        for (const d of this.names.values()) {
            if (d.ticker.toUpperCase().startsWith(q)) hits.push(d);
            if (hits.length >= 40) break;
        }
        hits.sort((a, b) => a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker));
        if (hits.length < 8) {
            for (const d of this.names.values()) {
                if (hits.length >= 8) break;
                if (!hits.includes(d) && d.description?.toUpperCase().includes(q)) hits.push(d);
            }
        }
        this.suggest.replaceChildren(
            ...hits.slice(0, 8).map((d) => {
                const r = el('div', 'wl-suggest-row');
                r.dataset.symbol = d.ticker;
                r.append(el('b', '', d.ticker), el('span', '', ` ${d.description ?? ''}`), el('em', '', d.prefix ?? ''));
                r.onmousedown = (e) => {
                    e.preventDefault();
                    this.add(d.ticker);
                };
                return r;
            }),
        );
        this.suggest.hidden = hits.length === 0;
    }

    private add(raw: string): void {
        const sym = bareSymbol(raw);
        if (!sym || !/^[A-Z0-9.^=/-]{1,20}$/.test(sym)) return;
        if (this.doc.groups.length === 0) this.doc.groups.push({ name: 'Watchlist', symbols: [] });
        const g = this.doc.groups[Number(this.groupSelect.value) || 0] ?? this.doc.groups[0]!;
        if (!g.symbols.includes(sym)) {
            g.symbols.push(sym);
            track('wl', sym);
        }
        g.collapsed = false;
        this.search.value = '';
        this.suggest.hidden = true;
        this.save();
        this.render();
        void this.refresh();
    }

    private newGroup(): void {
        const n = prompt('New group name')?.trim();
        if (!n) return;
        this.doc.groups.push({ name: n.slice(0, 60), symbols: [] });
        this.save();
        this.render();
        this.groupSelect.value = String(this.doc.groups.length - 1);
    }

    private async reset(): Promise<void> {
        if (!confirm('Replace your watchlist with the default groups?')) return;
        this.doc = await this.defaults();
        this.save();
        this.render();
        void this.refresh();
    }
}
