// Mobile bottom bar — the ONE navigation surface of the mobile chrome. Six stops, left
// to right: symbol (fullscreen search), timeframe (drawer on a tap, the quick-switch
// wheel on a press and hold), indicators (fullscreen picker), drawings (drawer), the
// three-dots drawer (everything else), and chart settings — then any side panel placed
// on the bar (`mobile: 'bar'`). A shell with `mobileSettings: 'menu'` drops the settings
// stop (the drawer carries it instead). It replaces BOTH desktop bars: this stylesheet
// also carries the mobile visibility flips for the topbar and the desktop bottombar, so
// the whole swap lives in one place and follows the root's `data-layout` attribute with
// no JS.
import { iconEl } from '../ui/icons';
import { injectStyles } from '../ui/styles';
import { parseSymbol } from '../data/ProviderRegistry';
import { timeframeLabel } from './timeframe';
import { mobilePlacement, widgetActions, type SidePanelButton, type WidgetContext } from './contributions';
import { TOPBAR_BUILTIN_IDS } from './topbar-composition';
import { TimeframeWheel } from './timeframe-wheel';

const STYLE_ID = 'vela-widget-mobilebar';
const CSS = `
.vela-mobilebar {
    display: none;
    align-items: stretch;
    gap: 2px;
    padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--vela-border);
    color: var(--vela-fg-muted);
    flex: none;
}
[data-layout='mobile'] .vela-mobilebar { display: flex; }
[data-layout='mobile'] .vela-widget-topbar { display: none; }
[data-layout='mobile'] .vela-widget-bottombar { display: none; }
.vela-mb-item {
    all: unset;
    flex: 1 1 0;
    min-width: 0;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--vela-fg-bright);
    font-size: 13px;
    font-weight: 600;
    -webkit-tap-highlight-color: transparent;
}
.vela-mb-item[hidden] { display: none !important; }
.vela-mb-item:active { background: var(--vela-hover); }
.vela-mb-item .vela-icon { font-size: 18px; width: 18px; height: 18px; }
/* A lit stop (the maximize toggle while something is isolated): the inverse
   "selected" chip — white on the dark theme, dark on the light one. */
.vela-mb-item.vela-mb-on, .vela-mb-item.vela-mb-on:active { background: var(--vela-selected-bg); color: var(--vela-selected-fg); }
/* Left-aligned contributed actions get their own stops (the built-in indicators
   slot) — the wrapper is layout-transparent so each stop flexes like a sibling. */
.vela-mb-actions, .vela-mb-panels { display: contents; }
.vela-mb-tf {
    /* The stop owns its touches while held (the wheel follows the finger), and a long
       press must not raise the browser's own callout. */
    touch-action: none;
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
}
.vela-mb-symbol {
    flex: 1.6 1 0;
    font-size: 14px;
    letter-spacing: 0.3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    line-height: 44px;
    text-align: center;
}
`;

export interface MobileBarOptions {
    symbol: string;
    timeframe: string;
    onSymbolClick: () => void;
    onTimeframeClick: () => void;
    /** Press and hold the timeframe stop to roll through these timeframes, release to
     *  switch. Omitted ⇒ the stop only taps. */
    timeframeWheel?: {
        timeframes: () => readonly string[];
        current: () => string;
        onSelect: (tf: string) => void;
    };
    /** Omitted ⇒ no indicators stop (the composition hides the 'indicators' slot, or
     *  the deprecated `indicatorPicker: false`). A slot OVERRIDE keeps the stop — the
     *  shell passes a callback routed to the override. */
    onIndicatorsClick?: () => void;
    /** Omitted ⇒ no drawings stop (the shell disabled user drawings — `drawings: false`). */
    onDrawingsClick?: () => void;
    /** Omitted ⇒ no maximize stop (single-chart shells — nothing to isolate). The
     *  workspace passes a toggle that isolates the active chart over the grid;
     *  {@link setMaximizeActive} lights the stop while something is isolated. */
    onMaximizeClick?: () => void;
    onMoreClick: () => void;
    /** Omitted ⇒ no settings stop (the shell moved Chart settings into the drawer). */
    onSettingsClick?: () => void;
    /** Live widget context — left-aligned contributed actions (`align: 'left'`)
     *  project as icon-only stops in the indicators slot. */
    getContext?: () => WidgetContext;
}

export class MobileBar {
    readonly el: HTMLElement;
    private readonly symbolEl: HTMLElement;
    private readonly tfEl: HTMLElement;
    /** The maximize toggle stop (null when the shell has nothing to isolate). */
    private readonly maxEl: HTMLButtonElement | null;
    /** Left-aligned contributed actions — filled by {@link renderActions}. */
    private readonly actionsHost: HTMLElement;
    /** Side panels placed on the bar — filled by {@link setPanelButtons}. */
    private readonly panelsHost: HTMLElement;
    private readonly wheel: TimeframeWheel | null;
    private readonly opts: MobileBarOptions;

    constructor(host: HTMLElement, opts: MobileBarOptions) {
        this.opts = opts;
        const doc = host.ownerDocument;
        injectStyles(STYLE_ID, CSS, doc);
        this.el = doc.createElement('div');
        this.el.className = 'vela-mobilebar';

        const item = (cls: string, label: string, onClick: () => void, icon?: string): HTMLButtonElement => {
            const b = doc.createElement('button');
            b.className = `vela-mb-item ${cls}`;
            b.setAttribute('aria-label', label);
            if (icon) b.appendChild(iconEl(icon, doc));
            b.addEventListener('click', onClick);
            return b;
        };

        this.symbolEl = item('vela-mb-symbol', 'Symbol search', opts.onSymbolClick);
        this.symbolEl.textContent = parseSymbol(opts.symbol).ticker;
        // The click that ends a hold belongs to the wheel, not the drawer.
        this.tfEl = item('vela-mb-tf', 'Timeframe', () => {
            if (!this.wheel?.consumeClick()) opts.onTimeframeClick();
        });
        this.tfEl.textContent = timeframeLabel(opts.timeframe);
        const tfWheel = opts.timeframeWheel;
        this.wheel = tfWheel
            ? new TimeframeWheel(this.tfEl, {
                  host,
                  ...tfWheel,
                  onActiveChange: (active) => this.tfEl.classList.toggle('vela-mb-on', active),
              })
            : null;
        const onIndicators = opts.onIndicatorsClick;
        const indicators = onIndicators ? item('vela-mb-indicators', 'Indicators', onIndicators, 'indicators') : null;
        this.actionsHost = doc.createElement('span');
        this.actionsHost.className = 'vela-mb-actions';
        const onDrawings = opts.onDrawingsClick;
        const drawings = onDrawings ? item('vela-mb-drawings', 'Drawings', onDrawings, 'pen') : null;
        const onMaximize = opts.onMaximizeClick;
        this.maxEl = onMaximize ? item('vela-mb-maximize', 'Maximize chart', onMaximize, 'maximize') : null;
        const more = item('vela-mb-more', 'More', opts.onMoreClick, 'kebab');
        const onSettings = opts.onSettingsClick;
        const settings = onSettings ? item('vela-mb-settings', 'Chart settings', onSettings, 'gear') : null;
        this.panelsHost = doc.createElement('span');
        this.panelsHost.className = 'vela-mb-panels';

        this.el.append(this.symbolEl, this.tfEl, ...(indicators ? [indicators] : []), this.actionsHost, ...(drawings ? [drawings] : []), ...(this.maxEl ? [this.maxEl] : []), more, ...(settings ? [settings] : []), this.panelsHost);
        host.appendChild(this.el);
        this.renderActions();
    }

    /** Re-project the contributed actions placed on the bar (left-aligned by default —
     *  see `mobilePlacement`) as icon-only stops in the indicators slot (call after
     *  registrations change). The rest are three-dots drawer rows. */
    renderActions(): void {
        const ctx = this.opts.getContext?.();
        if (!ctx) return;
        const doc = this.el.ownerDocument;
        this.actionsHost.replaceChildren();
        // Built-in-id actions are slot OVERRIDES — they reach mobile through the slot's
        // own stop (the shell routes it), never as an extra flow stop here.
        const builtin = new Set<string>(TOPBAR_BUILTIN_IDS);
        for (const action of widgetActions('topbar', ctx).filter((a) => mobilePlacement(a) === 'bar' && !builtin.has(a.id))) {
            const b = doc.createElement('button');
            b.className = 'vela-mb-item';
            b.setAttribute('aria-label', action.label);
            if (action.icon) b.appendChild(iconEl(action.icon, doc));
            else b.appendChild(doc.createTextNode(action.label));
            b.addEventListener('click', () => {
                const c = this.opts.getContext?.();
                if (c) action.run(c);
            });
            this.actionsHost.appendChild(b);
        }
    }

    /**
     * The panel toggles (the dock's {@link PanelChrome} contract, like the topbar's group):
     * only panels placed on the bar (`mobile: 'bar'`) get a stop; the rest stay rows in
     * the three-dots drawer. A stop lights while its panel is open.
     */
    setPanelButtons(buttons: readonly SidePanelButton[], onClick: (id: string) => void): void {
        const doc = this.el.ownerDocument;
        this.panelsHost.replaceChildren(
            ...buttons
                .filter((p) => p.mobile === 'bar')
                .map((p) => {
                    const b = doc.createElement('button');
                    b.className = 'vela-mb-item vela-mb-panel';
                    b.dataset.panel = p.id;
                    b.setAttribute('aria-label', p.title);
                    b.setAttribute('aria-pressed', 'false');
                    b.appendChild(iconEl(p.icon, doc));
                    b.addEventListener('click', () => onClick(p.id));
                    return b;
                }),
        );
    }

    setPanelActive(id: string, open: boolean): void {
        for (const b of this.panelsHost.querySelectorAll<HTMLElement>('.vela-mb-panel')) {
            if (b.dataset.panel !== id) continue;
            b.classList.toggle('vela-mb-on', open);
            b.setAttribute('aria-pressed', String(open));
        }
    }

    setSymbol(symbol: string): void {
        this.symbolEl.textContent = parseSymbol(symbol).ticker;
    }

    setTimeframe(tf: string): void {
        this.tfEl.textContent = timeframeLabel(tf);
    }

    /** Light the maximize stop while something is isolated (a chart over the grid,
     *  or a maximized pane inside the active chart) — inverse chip + restore glyph. */
    setMaximizeActive(on: boolean): void {
        if (!this.maxEl) return;
        this.maxEl.classList.toggle('vela-mb-on', on);
        this.maxEl.setAttribute('aria-label', on ? 'Restore layout' : 'Maximize chart');
        this.maxEl.replaceChildren(iconEl(on ? 'restore' : 'maximize', this.el.ownerDocument));
    }

    /** Show the maximize stop only while the grid holds more than one chart — on a
     *  one-cell layout there is nothing to isolate, so the stop would be a dead press. */
    setMaximizeVisible(visible: boolean): void {
        if (!this.maxEl) return;
        this.maxEl.hidden = !visible;
    }

    /** Close the timeframe wheel without switching (a layout flip mid-hold). */
    closeTimeframeWheel(): void {
        this.wheel?.cancel();
    }

    destroy(): void {
        this.wheel?.destroy();
        this.el.remove();
    }
}
