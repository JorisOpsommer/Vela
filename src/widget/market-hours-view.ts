// Market hours VIEW — projects a MarketHoursCard onto DOM: the hover card beside the
// status line's market badge (desktop: a day bar under the countdown) and the phone
// sheet's body (a 24-hour dial beside it). One builder, two variants; the owner rebuilds
// it whenever the minute turns.
import type { MarketStatus } from './statusline';
import type { MarketHoursArc, MarketHoursCard, SessionPart } from './market-hours';
import { SESSION_PRE, SESSION_POST, SESSION_OFF } from '../core/palette';
import { injectStyles } from '../ui/styles';

/** Session ink: open wears the theme's up color; the other sessions are meaning
 *  constants from the palette (amber pre, sky post and extended, gray closed/holiday). */
export const MARKET_INKS: Record<MarketStatus, string> = {
    open: 'var(--vela-up)',
    pre: SESSION_PRE,
    post: SESSION_POST,
    extended: SESSION_POST,
    closed: SESSION_OFF,
    holiday: SESSION_OFF,
};

const PART_INKS: Record<SessionPart, string> = { pre: SESSION_PRE, open: 'var(--vela-up)', post: SESSION_POST };

const STYLE_ID = 'vela-widget-market-hours';
const CSS = `
.vela-mh {
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--vela-fg);
    font-size: var(--vela-font-size-md);
    font-variant-numeric: tabular-nums;
}
.vela-mh[data-variant='card'] {
    width: 320px;
    box-sizing: border-box;
    padding: 12px 14px;
    background: var(--vela-surface);
    border: 1px solid var(--vela-border-strong);
    border-radius: 8px;
    box-shadow: var(--vela-shadow);
}
.vela-mh-head { display: flex; align-items: center; gap: 8px; }
.vela-mh-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.vela-mh-title { color: var(--vela-fg-bright); font-weight: 600; }
.vela-mh-day { margin-left: auto; color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); }
.vela-mh-lead { display: flex; align-items: center; gap: 16px; }
.vela-mh-lead-text { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 8px; row-gap: 2px; }
.vela-mh-headline { color: var(--vela-fg-bright); font-size: 24px; font-weight: 600; letter-spacing: -0.3px; line-height: 1.15; }
.vela-mh-caption { color: var(--vela-fg-muted); }
.vela-mh[data-variant='sheet'] .vela-mh-lead-text { flex-direction: column; align-items: flex-start; }
.vela-mh[data-variant='sheet'] .vela-mh-headline { font-size: 30px; }
.vela-mh-dial { width: 96px; height: 96px; flex: none; }
.vela-mh-bar { position: relative; height: 8px; border-radius: 4px; background: var(--vela-hover-strong); margin-top: 2px; }
.vela-mh-arc { position: absolute; top: 0; bottom: 0; opacity: 0.85; }
.vela-mh-arc[data-edge~='start'] { border-top-left-radius: 4px; border-bottom-left-radius: 4px; }
.vela-mh-arc[data-edge~='end'] { border-top-right-radius: 4px; border-bottom-right-radius: 4px; }
.vela-mh-now { position: absolute; top: -4px; width: 2px; height: 16px; margin-left: -1px; border-radius: 1px; background: var(--vela-fg-bright); box-shadow: 0 0 0 2px var(--vela-surface); }
.vela-mh-ticks { position: relative; height: 14px; margin-top: -6px; color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); }
.vela-mh-ticks > span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.vela-mh-ticks > span:first-child { transform: none; }
.vela-mh-ticks > span:last-child { transform: translateX(-100%); }
.vela-mh-rows { display: flex; flex-direction: column; gap: 8px; }
.vela-mh-row { display: flex; align-items: baseline; gap: 8px; }
.vela-mh-row .vela-mh-dot { width: 6px; height: 6px; align-self: center; }
.vela-mh-row-label { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.vela-mh-row-name { color: var(--vela-fg-bright); }
.vela-mh-row-market { color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); }
.vela-mh-row-time { color: var(--vela-fg-bright); white-space: nowrap; }
.vela-mh-row-time sup { margin-left: 1px; color: var(--vela-fg-muted); font-size: 9px; }
.vela-mh-sep { height: 1px; background: var(--vela-border); }
.vela-mh-section { color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.vela-mh-notices { display: flex; flex-direction: column; gap: 8px; }
.vela-mh-notice { display: flex; align-items: baseline; gap: 10px; }
.vela-mh-notice-date { flex: none; width: 104px; color: var(--vela-fg-bright); }
.vela-mh-notice-text { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; line-height: 1.4; }
.vela-mh-badge { padding: 0 6px; border-radius: 4px; font-size: var(--vela-font-size-sm); font-weight: 600; line-height: 18px; }
.vela-mh-zone { color: var(--vela-fg-muted); font-size: var(--vela-font-size-sm); }
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function dot(doc: Document, ink: string): HTMLElement {
    const d = el(doc, 'span', 'vela-mh-dot');
    d.style.background = ink;
    return d;
}

/** The 24-hour local dial: the day's stretches as arcs, midnight at the top, a hand at now. */
function dial(doc: Document, arcs: MarketHoursArc[], now: number, label: string): SVGSVGElement {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'vela-mh-dial');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const r = 40;
    const c = 2 * Math.PI * r;
    const ring = (stroke: string, from = 0, to = 1): SVGCircleElement => {
        const circle = doc.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', '50');
        circle.setAttribute('cy', '50');
        circle.setAttribute('r', String(r));
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke-width', '10');
        circle.style.stroke = stroke;
        if (to - from < 1) {
            circle.setAttribute('stroke-dasharray', `${Math.max(0, (to - from) * c - 0.8)} ${c}`);
            circle.setAttribute('stroke-dashoffset', String(-from * c));
        }
        circle.setAttribute('transform', 'rotate(-90 50 50)');
        return circle;
    };
    svg.appendChild(ring('var(--vela-hover-strong)'));
    for (const a of arcs) svg.appendChild(ring(PART_INKS[a.part], a.from, a.to));
    const angle = now * 2 * Math.PI;
    const x = (radius: number): string => (50 + radius * Math.sin(angle)).toFixed(2);
    const y = (radius: number): string => (50 - radius * Math.cos(angle)).toFixed(2);
    const hand = doc.createElementNS(SVG_NS, 'line');
    hand.setAttribute('x1', '50');
    hand.setAttribute('y1', '50');
    hand.setAttribute('x2', x(r - 9));
    hand.setAttribute('y2', y(r - 9));
    hand.setAttribute('stroke-width', '3');
    hand.setAttribute('stroke-linecap', 'round');
    hand.style.stroke = 'var(--vela-fg-bright)';
    const tip = doc.createElementNS(SVG_NS, 'circle');
    tip.setAttribute('cx', x(r));
    tip.setAttribute('cy', y(r));
    tip.setAttribute('r', '5');
    tip.setAttribute('stroke-width', '2.5');
    tip.style.fill = 'var(--vela-fg-bright)';
    tip.style.stroke = 'var(--vela-surface)';
    const hub = doc.createElementNS(SVG_NS, 'circle');
    hub.setAttribute('cx', '50');
    hub.setAttribute('cy', '50');
    hub.setAttribute('r', '3.5');
    hub.style.fill = 'var(--vela-fg-bright)';
    svg.append(hand, tip, hub);
    return svg;
}

/** Build the card (`'card'`, desktop hover) or the phone sheet body (`'sheet'`). */
export function renderMarketHours(doc: Document, card: MarketHoursCard, variant: 'card' | 'sheet'): HTMLElement {
    injectStyles(STYLE_ID, CSS, doc);
    const root = el(doc, 'div', 'vela-mh');
    root.dataset.variant = variant;
    root.dataset.status = card.status;

    const head = el(doc, 'div', 'vela-mh-head');
    head.append(dot(doc, MARKET_INKS[card.status]), el(doc, 'span', 'vela-mh-title', card.title), el(doc, 'span', 'vela-mh-day', card.day));
    root.appendChild(head);

    if (card.headline) {
        const lead = el(doc, 'div', 'vela-mh-lead');
        if (variant === 'sheet') {
            const local = card.rows.map((r) => `${r.label} ${r.time}`).join(', ');
            lead.appendChild(dial(doc, card.dial.arcs, card.dial.now, `24-hour clock in your time: ${local}`));
        }
        const text = el(doc, 'div', 'vela-mh-lead-text');
        text.append(el(doc, 'span', 'vela-mh-headline', card.headline), el(doc, 'span', 'vela-mh-caption', card.caption));
        lead.appendChild(text);
        root.appendChild(lead);
    }

    if (variant === 'card') {
        const bar = el(doc, 'div', 'vela-mh-bar');
        bar.setAttribute('aria-hidden', 'true');
        card.bar.arcs.forEach((a, i) => {
            const arc = el(doc, 'span', 'vela-mh-arc');
            arc.dataset.edge = [i === 0 ? 'start' : '', i === card.bar.arcs.length - 1 ? 'end' : ''].join(' ').trim();
            arc.style.left = `${a.from * 100}%`;
            arc.style.width = `${(a.to - a.from) * 100}%`;
            arc.style.background = PART_INKS[a.part];
            bar.appendChild(arc);
        });
        if (card.bar.now != null) {
            const now = el(doc, 'span', 'vela-mh-now');
            now.style.left = `${card.bar.now * 100}%`;
            bar.appendChild(now);
        }
        const ticks = el(doc, 'div', 'vela-mh-ticks');
        ticks.setAttribute('aria-hidden', 'true');
        for (const t of card.bar.ticks) {
            const tick = el(doc, 'span', '', t.label);
            tick.style.left = `${t.at * 100}%`;
            ticks.appendChild(tick);
        }
        root.append(bar, ticks);
    }

    const rows = el(doc, 'div', 'vela-mh-rows');
    for (const r of card.rows) {
        const row = el(doc, 'div', 'vela-mh-row');
        const label = el(doc, 'span', 'vela-mh-row-label');
        label.appendChild(el(doc, 'span', 'vela-mh-row-name', r.label));
        if (r.market) label.appendChild(el(doc, 'span', 'vela-mh-row-market', r.market));
        const time = el(doc, 'span', 'vela-mh-row-time', r.time);
        if (r.nextDay) {
            const sup = doc.createElement('sup');
            sup.textContent = '+1';
            sup.title = 'The next day';
            time.appendChild(sup);
        }
        row.append(dot(doc, PART_INKS[r.part]), label, time);
        rows.appendChild(row);
    }
    root.appendChild(rows);

    if (card.notices.length > 0) {
        const list = el(doc, 'div', 'vela-mh-notices');
        for (const n of card.notices) {
            const item = el(doc, 'div', 'vela-mh-notice');
            item.dataset.kind = n.kind;
            const text = el(doc, 'span', 'vela-mh-notice-text');
            if (n.badge) {
                const badge = el(doc, 'span', 'vela-mh-badge', n.badge);
                const ink = n.kind === 'holiday' ? SESSION_OFF : SESSION_PRE;
                badge.style.color = ink;
                badge.style.background = `color-mix(in srgb, ${ink} 16%, transparent)`;
                text.appendChild(badge);
            }
            text.appendChild(doc.createTextNode(n.text));
            item.append(el(doc, 'span', 'vela-mh-notice-date', n.date), text);
            list.appendChild(item);
        }
        root.append(el(doc, 'div', 'vela-mh-sep'), el(doc, 'div', 'vela-mh-section', 'Coming up'), list);
    }

    root.appendChild(el(doc, 'div', 'vela-mh-zone', `Times in ${card.zone}`));
    return root;
}
