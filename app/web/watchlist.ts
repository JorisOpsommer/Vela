// The watchlist side panel: grouped symbols with live last price and change, saved per
// account. Clicking a row loads it in the active chart.
import type { SidePanelDescriptor, WidgetContext } from '../../src/plugin';
import type { SymbolDescriptor } from '../../src';
import { api } from './lib/api';
import { reportTiming } from './lib/timing';
import type { ServerStorage } from './lib/storage';
import type { ServerProvider } from './lib/server-provider';
import { track } from './lib/tracker';
import { symbolGlyph } from './lib/symbol-glyph';
import { moveWatchSymbol, type WatchSlot } from './lib/watchlist-move';
import { DEFAULT_TAB, settleTabs } from './lib/watchlist-tabs';

export interface WatchGroup {
    name: string;
    symbols: string[];
    collapsed?: boolean;
    /** The tab this group sits under. */
    tab?: string;
}

interface WatchDoc {
    version: 1;
    tabs: string[];
    groups: WatchGroup[];
}

interface QuoteRow {
    symbol: string;
    price: number;
    change: number | null;
    changePct: number | null;
    time: number;
    /** The latest pre/post-market trade, while the regular session is closed. */
    extended?: { session: 'pre' | 'post'; price: number; changePct: number | null };
    /** Set on a price from the server's cache: when it was fetched. Live prices carry none. */
    asOf?: number;
}

/** A row being dragged by its grip in edit mode. The ghost exists once the pointer passed the threshold. */
interface WatchDrag {
    from: WatchSlot;
    row: HTMLElement;
    pointerId: number;
    x0: number;
    y0: number;
    x: number;
    y: number;
    /** Pointer offset inside the row, plus any shift of the fixed ghost's containing block. */
    dx: number;
    dy: number;
    ghost: HTMLElement | null;
    target: { el: HTMLElement; cls: string; slot: WatchSlot } | null;
    raf: number;
    off: AbortController;
}

const STORAGE_KEY = 'watchlist';
const REFRESH_MS = 10_000;
const DRAG_THRESHOLD = 4;
const SCROLL_EDGE = 24;

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
        const d = JSON.parse(raw) as Partial<WatchDoc> & { version?: unknown };
        if (d?.version !== 1 || !Array.isArray(d.groups)) return null;
        const groups = d.groups
            .filter((g) => g && typeof g.name === 'string' && Array.isArray(g.symbols))
            .map((g) => ({
                name: g.name.slice(0, 60),
                symbols: g.symbols.filter((s) => typeof s === 'string').map(bareSymbol).slice(0, 200),
                collapsed: g.collapsed === true,
                tab: typeof g.tab === 'string' ? g.tab.slice(0, 60) : undefined,
            }));
        const tabs = Array.isArray(d.tabs) ? d.tabs.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 60)) : [];
        return { version: 1, ...settleTabs({ tabs, groups }) };
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
    private doc: WatchDoc = { version: 1, tabs: [DEFAULT_TAB], groups: [] };
    /** The tab on show. Kept per viewer, so a reload opens the first tab again. */
    private activeTab = DEFAULT_TAB;
    private quotes = new Map<string, QuoteRow>();
    private names = new Map<string, SymbolDescriptor>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly tabBar = el('div', 'wl-tabs');
    private readonly list = el('div', 'wl-list');
    private readonly search = el('input', 'wl-search');
    private readonly suggest = el('div', 'wl-suggest');
    private readonly groupSelect = el('select', 'wl-group-select');
    private lastActive = '';
    /** First paint: the cached prices go up at once, the live ones replace them. */
    private primed = false;
    private liveSeen = false;
    private readonly bornAt = performance.now();
    private editing = false;
    private drag: WatchDrag | null = null;
    /** A render asked for mid-drag: it would detach the dragged row, so it waits for the drop. */
    private renderPending = false;

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
        const editBtn = el('button', 'wl-icon-btn', '✎');
        editBtn.title = 'Edit watchlist';
        editBtn.setAttribute('aria-pressed', 'false');
        editBtn.onclick = () => {
            this.editing = !this.editing;
            if (!this.editing) this.endDrag(false);
            body.classList.toggle('wl-editing', this.editing);
            editBtn.classList.toggle('on', this.editing);
            editBtn.title = this.editing ? 'Done editing' : 'Edit watchlist';
            editBtn.setAttribute('aria-pressed', String(this.editing));
        };
        slot.append(editBtn, newGroupBtn, resetBtn);

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

        body.append(this.tabBar, addRow, this.list);
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
                this.endDrag(false);
            },
        };
    }

    private async load(): Promise<void> {
        let doc = parseDoc((await this.storage.get(STORAGE_KEY)) as string | null);
        if (!doc) doc = await this.defaults();
        this.doc = doc;
        this.activeTab = doc.tabs[0]!;
        this.render();
        void this.refresh();
        this.timer = setInterval(() => {
            if (document.visibilityState === 'visible' && this.body.isConnected && this.body.offsetParent !== null) void this.refresh();
            this.markActive();
        }, REFRESH_MS);
    }

    private async defaults(): Promise<WatchDoc> {
        const r = await api<{ groups: WatchGroup[] }>('/api/watchlist/defaults');
        return { version: 1, ...settleTabs({ groups: r.groups.map((g) => ({ name: g.name, symbols: g.symbols })) }) };
    }

    private save(): void {
        this.storage.set(STORAGE_KEY, JSON.stringify(this.doc));
    }

    private allSymbols(): string[] {
        return [...new Set(this.doc.groups.flatMap((g) => g.symbols))];
    }

    /** Paint the server's last known prices while the live ones load. */
    private async prime(syms: string[]): Promise<void> {
        const t0 = performance.now();
        const r = await api<{ quotes: QuoteRow[] }>(`/api/quotes?cache=only&symbols=${encodeURIComponent(syms.join(','))}`).catch(() => null);
        if (!r || this.liveSeen || r.quotes.length === 0) return;
        for (const q of r.quotes) {
            if (this.quotes.has(q.symbol)) continue;
            this.quotes.set(q.symbol, q);
            this.paintQuote(q);
        }
        reportTiming('quotes-cached', performance.now() - t0);
    }

    private async refresh(): Promise<void> {
        const syms = this.allSymbols();
        if (syms.length === 0) return;
        if (!this.primed) {
            this.primed = true;
            void this.prime(syms);
        }
        try {
            const r = await api<{ quotes: QuoteRow[] }>(`/api/quotes?symbols=${encodeURIComponent(syms.join(','))}`);
            if (!this.liveSeen) {
                this.liveSeen = true;
                const cachedFirst = [...this.quotes.values()].some((q) => q.asOf != null);
                if (!cachedFirst && r.quotes.length > 0) reportTiming('quotes-cold', performance.now() - this.bornAt);
            }
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
            row.classList.toggle('cached', q.asOf != null);
            if (q.asOf != null) last.title = `Last known price, ${new Date(q.asOf).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — updating`;
            else last.removeAttribute('title');
            this.paintExtended(row, q);
            if (prev && prev.price !== q.price) {
                last.classList.remove('flash-up', 'flash-down');
                void last.offsetWidth;
                last.classList.add(q.price > prev.price ? 'flash-up' : 'flash-down');
            }
        }
    }

    /** The pre/post-market line under the regular price: a sun before the open, a moon after the close. */
    private paintExtended(row: HTMLElement, q: QuoteRow): void {
        const ext = row.querySelector<HTMLElement>('.wl-ext')!;
        const x = q.extended;
        row.classList.toggle('has-ext', !!x);
        ext.hidden = !x;
        if (!x) return;
        const pct = x.changePct;
        ext.className = `wl-ext ${x.session}${pct == null ? '' : pct > 0 ? ' up' : pct < 0 ? ' down' : ''}`;
        ext.title = x.session === 'pre' ? 'Pre-market' : 'Post-market';
        ext.querySelector('.wl-ext-tag')!.textContent = x.session === 'pre' ? '☀' : '☾';
        ext.querySelector('.wl-ext-price')!.textContent = formatPrice(q.symbol, x.price);
        ext.querySelector('.wl-ext-chg')!.textContent = pct == null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }

    private markActive(): void {
        const active = bareSymbol(this.ctx.symbol ?? '');
        if (active === this.lastActive) return;
        this.lastActive = active;
        for (const row of this.list.querySelectorAll<HTMLElement>('.wl-row')) row.classList.toggle('active', row.dataset.symbol === active);
    }

    /** The tab strip: one button per tab, then rename and (when another tab is left) delete for the one on show. */
    private renderTabs(): void {
        const tabs = this.doc.tabs.map((name) => {
            const on = name === this.activeTab;
            const btn = el('button', 'wl-tab' + (on ? ' on' : ''), name);
            btn.dataset.tab = name;
            btn.setAttribute('aria-pressed', String(on));
            btn.onclick = () => {
                this.activeTab = name;
                this.render();
            };
            return btn;
        });
        const add = el('button', 'wl-icon-btn', '＋');
        add.title = 'New tab';
        add.onclick = () => this.newTab();
        const actions = el('span', 'wl-tab-actions');
        const ren = el('button', 'wl-mini', '✎');
        ren.title = 'Rename tab';
        ren.onclick = () => this.renameTab();
        actions.append(ren);
        if (this.doc.tabs.length > 1) {
            const del = el('button', 'wl-mini', '✕');
            del.title = 'Delete tab';
            del.onclick = () => this.deleteTab();
            actions.append(del);
        }
        this.tabBar.replaceChildren(...tabs, add, actions);
    }

    private render(): void {
        if (this.drag) {
            this.renderPending = true;
            return;
        }
        this.renderPending = false;
        this.renderTabs();
        // Group indexes stay global (into doc.groups) so a row or drop knows its group in any tab.
        this.groupSelect.replaceChildren(...this.doc.groups.flatMap((g, i) => (g.tab === this.activeTab ? [Object.assign(el('option', '', g.name), { value: String(i) })] : [])));
        this.groupSelect.title = 'Group to add to';
        const frag = document.createDocumentFragment();
        if (!this.doc.groups.some((g) => g.tab === this.activeTab)) frag.append(el('div', 'wl-empty', 'No groups in this tab yet.'));
        this.doc.groups.forEach((g, gi) => {
            if (g.tab !== this.activeTab) return;
            const head = el('div', 'wl-group');
            head.dataset.group = String(gi);
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
        row.dataset.group = String(gi);
        row.dataset.index = String(si);
        row.tabIndex = 0;
        const grip = el('span', 'wl-grip', '⠿');
        grip.title = 'Drag to move';
        grip.onpointerdown = (e) => this.grab(e, row, { group: gi, index: si });
        const icon = el('span', 'wl-ico');
        const iconUrl = d ? this.provider.resolveSymbolIcon(d) : undefined;
        const glyph = symbolGlyph(d ?? { ticker: sym });
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = iconUrl ?? glyph;
        if (iconUrl) {
            img.onerror = () => {
                img.onerror = null;
                img.src = glyph;
            };
        }
        icon.append(img);
        const label = el('span', 'wl-label');
        label.append(el('span', 'wl-sym', sym), el('span', 'wl-name', d?.description ?? ''));
        const last = el('span', 'wl-last', '—');
        const chg = el('span', 'wl-chg', '');
        const ext = el('span', 'wl-ext');
        ext.hidden = true;
        ext.append(el('span', 'wl-ext-tag'), el('span', 'wl-ext-price'), el('span', 'wl-ext-chg'));
        const rm = el('button', 'wl-remove', '✕');
        rm.title = 'Remove from watchlist';
        rm.onclick = (e) => {
            e.stopPropagation();
            this.doc.groups[gi]!.symbols.splice(si, 1);
            this.save();
            this.render();
        };
        row.append(grip, icon, label, last, chg, rm, ext);
        const open = () => {
            if (this.editing) return;
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

    /** Edit mode: a press on a row's grip; the drag itself starts once the pointer has moved a little. */
    private grab(e: PointerEvent, row: HTMLElement, from: WatchSlot): void {
        if (!this.editing || this.drag || e.button !== 0) return;
        e.preventDefault();
        const off = new AbortController();
        const [x, y] = [e.clientX, e.clientY];
        const d: WatchDrag = { from, row, pointerId: e.pointerId, x0: x, y0: y, x, y, dx: 0, dy: 0, ghost: null, target: null, raf: 0, off };
        this.drag = d;
        const opts = { signal: off.signal };
        document.addEventListener(
            'pointermove',
            (ev) => {
                if (ev.pointerId !== d.pointerId) return;
                d.x = ev.clientX;
                d.y = ev.clientY;
                if (!d.ghost) {
                    if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_THRESHOLD) return;
                    this.lift(d);
                }
                d.ghost!.style.left = `${d.x - d.dx}px`;
                d.ghost!.style.top = `${d.y - d.dy}px`;
                this.aim(d);
            },
            opts,
        );
        document.addEventListener(
            'pointerup',
            (ev) => {
                if (ev.pointerId !== d.pointerId) return;
                d.x = ev.clientX;
                d.y = ev.clientY;
                if (d.ghost) this.aim(d);
                this.endDrag(true);
            },
            opts,
        );
        document.addEventListener('pointercancel', (ev) => ev.pointerId === d.pointerId && this.endDrag(false), opts);
        window.addEventListener(
            'keydown',
            (ev) => {
                if (ev.key !== 'Escape') return;
                ev.preventDefault();
                ev.stopPropagation();
                this.endDrag(false);
            },
            { signal: off.signal, capture: true },
        );
        window.addEventListener('blur', () => this.endDrag(false), opts);
        this.list.addEventListener('scroll', () => d.ghost && this.aim(d), opts);
    }

    private lift(d: WatchDrag): void {
        const r = d.row.getBoundingClientRect();
        const ghost = d.row.cloneNode(true) as HTMLElement;
        ghost.classList.add('wl-ghost');
        ghost.removeAttribute('tabindex');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.style.width = `${r.width}px`;
        ghost.style.left = `${r.left}px`;
        ghost.style.top = `${r.top}px`;
        // Inside the panel body so the theme tokens apply; a transformed ancestor would shift a fixed box, so measure it.
        this.body.append(ghost);
        const g = ghost.getBoundingClientRect();
        d.dx = d.x0 - r.left + (g.left - r.left);
        d.dy = d.y0 - r.top + (g.top - r.top);
        d.ghost = ghost;
        d.row.classList.add('wl-dragging');
        this.body.classList.add('wl-drag-active');
        d.raf = requestAnimationFrame(() => this.autoScroll(d));
    }

    /** Hit-tests the pointer and moves the drop indicator; a drop that would change nothing shows none. */
    private aim(d: WatchDrag): void {
        const hit = document.elementFromPoint(d.x, d.y);
        const at = hit && this.list.contains(hit) ? hit.closest<HTMLElement>('.wl-row, .wl-group') : null;
        let next: WatchDrag['target'] = null;
        if (at?.classList.contains('wl-row')) {
            const r = at.getBoundingClientRect();
            const after = d.y > r.top + r.height / 2;
            const slot = { group: Number(at.dataset.group), index: Number(at.dataset.index) + (after ? 1 : 0) };
            next = { el: at, cls: after ? 'wl-drop-after' : 'wl-drop-before', slot };
        } else if (at) {
            next = { el: at, cls: 'wl-drop-into', slot: { group: Number(at.dataset.group), index: 0 } };
        }
        const cur = d.target;
        if (cur && next && cur.el === next.el && cur.cls === next.cls) return;
        const probe = this.doc.groups.map((g) => ({ symbols: [...g.symbols] }));
        if (next && !moveWatchSymbol(probe, d.from, next.slot)) next = null;
        cur?.el.classList.remove(cur.cls);
        next?.el.classList.add(next.cls);
        d.target = next;
    }

    private autoScroll(d: WatchDrag): void {
        if (this.drag !== d) return;
        const r = this.list.getBoundingClientRect();
        if (d.x >= r.left && d.x <= r.right) {
            const v = d.y < r.top + SCROLL_EDGE ? d.y - r.top - SCROLL_EDGE : d.y > r.bottom - SCROLL_EDGE ? d.y - r.bottom + SCROLL_EDGE : 0;
            if (v) this.list.scrollTop += Math.sign(v) * Math.ceil(Math.min(Math.abs(v), SCROLL_EDGE) / 2);
        }
        d.raf = requestAnimationFrame(() => this.autoScroll(d));
    }

    private endDrag(drop: boolean): void {
        const d = this.drag;
        if (!d) return;
        this.drag = null;
        d.off.abort();
        cancelAnimationFrame(d.raf);
        d.target?.el.classList.remove(d.target.cls);
        d.row.classList.remove('wl-dragging');
        this.body.classList.remove('wl-drag-active');
        if (d.ghost) {
            d.ghost.remove();
            // The release would land as a click on whatever is under it (a group header toggles).
            const swallow = (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
            };
            window.addEventListener('click', swallow, true);
            setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        }
        const to = drop && d.ghost ? d.target?.slot : undefined;
        if (to && moveWatchSymbol(this.doc.groups, d.from, to)) {
            this.doc.groups[to.group]!.collapsed = false;
            this.save();
            this.render();
        } else if (this.renderPending) {
            this.render();
        }
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
        let g = this.groupSelect.value ? this.doc.groups[Number(this.groupSelect.value)] : undefined;
        if (!g) {
            g = { name: this.activeTab, symbols: [], tab: this.activeTab };
            this.doc.groups.push(g);
        }
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
        this.doc.groups.push({ name: n.slice(0, 60), symbols: [], tab: this.activeTab });
        this.save();
        this.render();
        this.groupSelect.value = String(this.doc.groups.length - 1);
    }

    private newTab(): void {
        const n = prompt('New tab name')?.trim().slice(0, 60);
        if (!n) return;
        if (!this.doc.tabs.includes(n)) this.doc.tabs.push(n);
        this.activeTab = n;
        this.save();
        this.render();
    }

    private renameTab(): void {
        const from = this.activeTab;
        const to = prompt('Tab name', from)?.trim().slice(0, 60);
        if (!to || to === from) return;
        if (this.doc.tabs.includes(to)) {
            alert(`A tab named "${to}" already exists.`);
            return;
        }
        this.doc.tabs[this.doc.tabs.indexOf(from)] = to;
        for (const g of this.doc.groups) if (g.tab === from) g.tab = to;
        this.activeTab = to;
        this.save();
        this.render();
    }

    private deleteTab(): void {
        if (this.doc.tabs.length <= 1) return;
        const groups = this.doc.groups.filter((g) => g.tab === this.activeTab);
        const symbols = groups.reduce((n, g) => n + g.symbols.length, 0);
        if (groups.length && !confirm(`Delete "${this.activeTab}", its groups and their ${symbols} symbols?`)) return;
        const i = this.doc.tabs.indexOf(this.activeTab);
        this.doc.tabs.splice(i, 1);
        this.doc.groups = this.doc.groups.filter((g) => g.tab !== this.activeTab);
        this.activeTab = this.doc.tabs[Math.max(0, i - 1)]!;
        this.save();
        this.render();
    }

    private async reset(): Promise<void> {
        if (!confirm('Replace your watchlist with the default groups?')) return;
        this.doc = await this.defaults();
        this.activeTab = this.doc.tabs[0]!;
        this.save();
        this.render();
        void this.refresh();
    }
}
