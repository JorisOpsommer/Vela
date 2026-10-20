// Small dependency-free SVG charts for the stats and insights pages: stacked area and
// line charts with a crosshair tooltip, donuts, bar lists, gauges and a heatmap.

const NS = 'http://www.w3.org/2000/svg';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
export const OTHER = 'var(--series-other)';

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

// ── Tooltip ────────────────────────────────────────────────────────────────
let tipEl: HTMLDivElement | null = null;

function tip(): HTMLDivElement {
    if (!tipEl) {
        tipEl = h('div', 'tooltip');
        tipEl.hidden = true;
        document.body.append(tipEl);
    }
    return tipEl;
}

export interface TipRow {
    label: string;
    value: string;
    color?: string;
}

export function showTip(x: number, y: number, head: string, rows: TipRow[]): void {
    const t = tip();
    t.replaceChildren(h('div', 't-head', head));
    for (const r of rows) {
        const row = h('div', 't-row');
        const left = h('span');
        if (r.color) {
            const sw = h('i');
            sw.style.background = r.color;
            left.append(sw);
        }
        left.append(document.createTextNode(r.label));
        row.append(left, h('b', '', r.value));
        t.append(row);
    }
    t.hidden = false;
    const w = t.offsetWidth;
    const hgt = t.offsetHeight;
    const left = x + 14 + w > window.innerWidth ? x - w - 14 : x + 14;
    const top = Math.min(Math.max(8, y - hgt / 2), window.innerHeight - hgt - 8);
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
}

export function hideTip(): void {
    if (tipEl) tipEl.hidden = true;
}

// ── Scales ─────────────────────────────────────────────────────────────────
export function niceMax(v: number): number {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function fmt(v: number | null | undefined, digits = 0): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function legend(items: Array<{ label: string; color: string }>): HTMLElement {
    const box = h('div', 'legend');
    for (const it of items) {
        const s = h('span');
        const sw = h('i');
        sw.style.background = it.color;
        s.append(sw, document.createTextNode(it.label));
        box.append(s);
    }
    return box;
}

export interface Series {
    label: string;
    color: string;
    values: Array<number | null>;
}

/**
 * Time-series chart, stacked areas or plain lines, with a shared crosshair tooltip.
 * `xs` are epoch ms; one axis only.
 */
export function timeChart(host: HTMLElement, xs: number[], series: Series[], opts: { mode: 'stack' | 'line'; height?: number; unit?: string; digits?: number }): void {
    host.replaceChildren();
    host.classList.add('chart');
    if (series.length > 1) host.append(legend(series.map((s) => ({ label: s.label, color: s.color }))));
    const W = Math.max(320, host.clientWidth || 600);
    const H = opts.height ?? 200;
    const m = { l: 40, r: 10, t: 8, b: 22 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
    const n = xs.length;
    const x = (i: number) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);

    const stacks: number[][] = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
        let acc = 0;
        const col: number[] = [];
        for (const s of series) {
            const v = s.values[i] ?? 0;
            acc = opts.mode === 'stack' ? acc + v : v;
            col.push(acc);
            max = Math.max(max, acc);
        }
        stacks.push(col);
    }
    const top = niceMax(max * 1.1);
    const y = (v: number) => m.t + ih - (v / top) * ih;

    for (let k = 0; k <= 4; k++) {
        const v = (top / 4) * k;
        svg.append(svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
        const label = svgEl('text', { class: 'axis', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
        label.textContent = fmt(v, top < 5 ? 1 : 0);
        svg.append(label);
    }
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
        if (i < 0 || xs[i] == null) continue;
        const t = svgEl('text', { class: 'axis', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' });
        t.textContent = new Date(xs[i]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        svg.append(t);
    }

    series.forEach((s, si) => {
        if (opts.mode === 'stack') {
            let d = '';
            for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${x(i)},${y(stacks[i]![si]!)}`;
            for (let i = n - 1; i >= 0; i--) d += `L${x(i)},${y(si ? stacks[i]![si - 1]! : 0)}`;
            svg.append(svgEl('path', { d: `${d}Z`, fill: s.color, 'fill-opacity': 0.8, stroke: 'var(--surface-1)', 'stroke-width': 1 }));
        } else {
            let d = '';
            let pen = false;
            for (let i = 0; i < n; i++) {
                const v = s.values[i];
                if (v == null) {
                    pen = false;
                    continue;
                }
                d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
                pen = true;
            }
            svg.append(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
    });

    const cross = svgEl('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, stroke: 'var(--text-muted)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
    svg.append(cross);
    const hit = svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
        cross.setAttribute('x1', String(x(i)));
        cross.setAttribute('x2', String(x(i)));
        cross.setAttribute('visibility', 'visible');
        const rows = series.map((s) => ({ label: s.label, value: `${fmt(s.values[i] ?? null, opts.digits ?? 0)}${opts.unit ?? ''}`, color: s.color }));
        if (opts.mode === 'stack' && series.length > 1) rows.push({ label: 'Total', value: `${fmt(stacks[i]![series.length - 1]!, opts.digits ?? 0)}${opts.unit ?? ''}`, color: '' });
        showTip(ev.clientX, ev.clientY, new Date(xs[i]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), rows);
    });
    hit.addEventListener('pointerleave', () => {
        cross.setAttribute('visibility', 'hidden');
        hideTip();
    });
    svg.append(hit);
    host.append(svg);
}

/** Donut with hover; at most 5 colored slices plus a gray "Other". */
export function donut(host: HTMLElement, items: Array<{ label: string; value: number }>, opts: { centerLabel?: string; unit?: string } = {}): void {
    host.replaceChildren();
    host.classList.add('chart');
    const total = items.reduce((a, b) => a + b.value, 0);
    if (total <= 0) {
        host.append(h('div', 'empty', 'No data yet'));
        return;
    }
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, 5);
    const rest = sorted.slice(5).reduce((a, b) => a + b.value, 0);
    const slices = head.map((it, i) => ({ ...it, color: SERIES[i]! }));
    if (rest > 0) slices.push({ label: 'Other', value: rest, color: OTHER });

    const wrap = h('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:18px;flex-wrap:wrap';
    const S = 168;
    const R = 72;
    const r = 48;
    const svg = svgEl('svg', { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: 'img' });
    svg.style.width = `${S}px`;
    let a0 = -Math.PI / 2;
    const gap = slices.length > 1 ? 0.025 : 0;
    for (const s of slices) {
        const frac = s.value / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 - gap > Math.PI ? 1 : 0;
        const p = (rad: number, a: number) => `${S / 2 + rad * Math.cos(a)},${S / 2 + rad * Math.sin(a)}`;
        const s0 = a0 + gap / 2;
        const s1 = Math.max(s0 + 0.001, a1 - gap / 2);
        const d = frac >= 0.9999 ? `M${p(R, -Math.PI / 2)}A${R},${R} 0 1 1 ${p(R, -Math.PI / 2 - 0.0001)}L${p(r, -Math.PI / 2 - 0.0001)}A${r},${r} 0 1 0 ${p(r, -Math.PI / 2)}Z` : `M${p(R, s0)}A${R},${R} 0 ${large} 1 ${p(R, s1)}L${p(r, s1)}A${r},${r} 0 ${large} 0 ${p(r, s0)}Z`;
        const path = svgEl('path', { d, fill: s.color });
        path.style.cursor = 'default';
        path.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, s.label, [{ label: 'Share', value: `${fmt((s.value / total) * 100, 1)}%`, color: s.color }, { label: 'Count', value: `${fmt(s.value, 1)}${opts.unit ?? ''}` }]));
        path.addEventListener('pointerleave', hideTip);
        svg.append(path);
        a0 = a1;
    }
    if (opts.centerLabel) {
        const t1 = svgEl('text', { x: S / 2, y: S / 2 - 2, 'text-anchor': 'middle', fill: 'var(--text-primary)', 'font-size': 20, 'font-weight': 700 });
        t1.textContent = fmt(total, 0);
        const t2 = svgEl('text', { x: S / 2, y: S / 2 + 16, 'text-anchor': 'middle', fill: 'var(--text-muted)', 'font-size': 11 });
        t2.textContent = opts.centerLabel;
        svg.append(t1, t2);
    }
    const lg = h('div', 'legend');
    lg.style.flexDirection = 'column';
    lg.style.gap = '6px';
    for (const s of slices) {
        const row = h('span');
        const sw = h('i');
        sw.style.background = s.color;
        row.append(sw, document.createTextNode(`${s.label} · ${fmt((s.value / total) * 100, 0)}%`));
        lg.append(row);
    }
    wrap.append(svg, lg);
    host.append(wrap);
}

/** Horizontal bars; one series, so one hue family. */
export function barList(host: HTMLElement, rows: Array<{ label: string; value: number; display?: string; title?: string; lead?: HTMLElement }>, opts: { fill?: string } = {}): void {
    host.replaceChildren();
    if (rows.length === 0) {
        host.append(h('div', 'empty', 'No data yet'));
        return;
    }
    const max = Math.max(...rows.map((r) => r.value), 1);
    const box = h('div', 'bars');
    rows.forEach((r, i) => {
        const row = h('div', 'bar-row');
        const name = h('span', 'name');
        if (r.lead) name.append(r.lead);
        name.append(document.createTextNode(r.label));
        if (r.title) name.title = r.title;
        const track = h('span', 'track');
        const fill = h('span', 'fill');
        fill.style.width = `${Math.max(2, (r.value / max) * 100)}%`;
        fill.style.animationDelay = `${i * 40}ms`;
        if (opts.fill) fill.style.background = opts.fill;
        track.append(fill);
        row.append(name, track, h('span', 'num', r.display ?? fmt(r.value)));
        box.append(row);
    });
    host.append(box);
}

/** Semicircle gauge; `fraction` in [0, 1]. Colour steps to status at 70% / 90%. */
export function gauge(fraction: number | null, label: string): SVGSVGElement {
    const W = 140;
    const H = 84;
    const R = 56;
    const cx = W / 2;
    const cy = 72;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    const defs = svgEl('defs');
    const lg = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 0 });
    const f = fraction ?? 0;
    const [c0, c1] = f >= 0.9 ? ['#ff4f8b', '#d03b3b'] : f >= 0.7 ? ['#ffc44d', '#ff8a4c'] : ['#1fd1a5', '#2f8bff'];
    lg.append(svgEl('stop', { offset: 0, 'stop-color': c0 }), svgEl('stop', { offset: 1, 'stop-color': c1 }));
    defs.append(lg);
    svg.append(defs);
    const arc = (frac: number) => {
        const a = Math.PI * (1 - Math.min(Math.max(frac, 0), 1));
        return `M${cx - R},${cy} A${R},${R} 0 0 1 ${cx + R * Math.cos(a)},${cy - R * Math.sin(a)}`;
    };
    svg.append(svgEl('path', { d: arc(1), fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 12, 'stroke-linecap': 'round' }));
    if (fraction != null && fraction > 0.002) svg.append(svgEl('path', { d: arc(fraction), fill: 'none', stroke: `url(#${id})`, 'stroke-width': 12, 'stroke-linecap': 'round' }));
    const t = svgEl('text', { x: cx, y: cy - 8, 'text-anchor': 'middle', fill: 'var(--text-primary)', 'font-size': 20, 'font-weight': 700 });
    t.textContent = fraction == null ? '—' : `${Math.round(fraction * 100)}%`;
    const s = svgEl('text', { x: cx, y: cy + 8, 'text-anchor': 'middle', fill: 'var(--text-muted)', 'font-size': 10 });
    s.textContent = label;
    svg.append(t, s);
    return svg;
}

/** Tiny line, no axes — a trend glance inside a card. */
export function sparkline(values: number[], color: string, height = 34): SVGSVGElement {
    const W = 200;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', height, role: 'img' });
    svg.style.width = '100%';
    const max = Math.max(...values, 1);
    const n = values.length;
    const pts = values.map((v, i) => `${n <= 1 ? 0 : (i / (n - 1)) * W},${height - 2 - (v / max) * (height - 6)}`);
    const id = `s${Math.random().toString(36).slice(2, 8)}`;
    const defs = svgEl('defs');
    const lg = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.append(svgEl('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.45 }), svgEl('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }));
    defs.append(lg);
    svg.append(defs);
    if (n > 1) {
        svg.append(svgEl('path', { d: `M0,${height} L${pts.join(' L')} L${W},${height} Z`, fill: `url(#${id})` }));
        svg.append(svgEl('path', { d: `M${pts.join(' L')}`, fill: 'none', stroke: color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
    }
    return svg;
}

/** Weekday × hour grid on a single-hue sequential scale. */
export function heatmap(host: HTMLElement, grid: number[][]): void {
    host.replaceChildren();
    host.classList.add('chart');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const order = [1, 2, 3, 4, 5, 6, 0];
    const max = Math.max(...grid.flat(), 0);
    const cell = 16;
    const gap = 3;
    const left = 34;
    const W = left + 24 * (cell + gap);
    const H = 7 * (cell + gap) + 18;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    // Sequential blue, dark surface: low values recede, high values glow.
    const ramp = ['#1c2440', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#b7d3f6'];
    order.forEach((d, row) => {
        const lab = svgEl('text', { class: 'axis', x: left - 8, y: row * (cell + gap) + cell - 4, 'text-anchor': 'end' });
        lab.textContent = days[d]!;
        svg.append(lab);
        for (let hr = 0; hr < 24; hr++) {
            const v = grid[d]?.[hr] ?? 0;
            const step = max > 0 && v > 0 ? 1 + Math.min(ramp.length - 2, Math.floor((v / max) * (ramp.length - 1))) : 0;
            const rect = svgEl('rect', { x: left + hr * (cell + gap), y: row * (cell + gap), width: cell, height: cell, rx: 4, fill: ramp[step]! });
            rect.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, `${days[d]} ${String(hr).padStart(2, '0')}:00`, [{ label: 'Activity', value: fmt(v, 1) }]));
            rect.addEventListener('pointerleave', hideTip);
            svg.append(rect);
        }
    });
    for (const hr of [0, 6, 12, 18, 23]) {
        const t = svgEl('text', { class: 'axis', x: left + hr * (cell + gap) + cell / 2, y: H - 3, 'text-anchor': 'middle' });
        t.textContent = String(hr).padStart(2, '0');
        svg.append(t);
    }
    host.append(svg);
}
