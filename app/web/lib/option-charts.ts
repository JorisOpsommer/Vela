// Charts for the options page, on the same dependency-free SVG footing as viz.ts:
// mirrored bars by strike (calls above the baseline, puts below) and line charts over a
// numeric axis (strike, days to expiry, price), each with reference lines for the levels
// a trader looks for — spot, the walls, max pain, the gamma flip.
import { fmt, hideTip, legend, niceMax, showTip, svgEl, type TipRow } from './viz';

export interface RefLine {
    at: number;
    label: string;
    /** Spot is drawn solid; every other level dashed. */
    strong?: boolean;
}

export interface StrikeBar {
    strike: number;
    up: number;
    down: number;
}

/** Rows of reference-line labels above the plot: as many as overlapping labels need, at most this. */
const REF_ROWS = 3;
const REF_ROW_H = 13;

function refLines(svg: SVGSVGElement, lines: readonly RefLine[], px: (v: number) => number, lo: number, hi: number, top: number, bottom: number): void {
    // Each label takes the lowest row where it clears the labels already placed; one that
    // fits no row keeps its line and drops the text (the tooltip and KPIs still name it).
    const rows: Array<Array<[number, number]>> = Array.from({ length: REF_ROWS }, () => []);
    const visible = lines.filter((l) => l.at >= lo && l.at <= hi).sort((a, b) => Number(!!b.strong) - Number(!!a.strong));
    for (const l of visible) {
        const x = px(l.at);
        svg.append(svgEl('line', { x1: x, x2: x, y1: top, y2: bottom, stroke: l.strong ? 'var(--text-secondary)' : 'var(--text-muted)', 'stroke-width': l.strong ? 1.5 : 1, 'stroke-dasharray': l.strong ? '' : '4 3' }));
        const half = (l.label.length * 5.6) / 2 + 4;
        const row = rows.findIndex((r) => r.every(([a, b]) => x + half < a || x - half > b));
        if (row < 0) continue;
        rows[row]!.push([x - half, x + half]);
        const t = svgEl('text', { class: 'axis ref', x, y: top - 4 - row * REF_ROW_H, 'text-anchor': 'middle' });
        t.textContent = l.label;
        svg.append(t);
    }
}

/**
 * Bars by strike on one shared scale. `mirror` (default): `up` above the baseline, `down`
 * below it. `paired`: both are signed changes, side by side — each bar rises for a gain
 * and drops for a loss. Every strike's whole column is its hover target.
 */
export function strikeBars(
    host: HTMLElement,
    rows: readonly StrikeBar[],
    opts: { upLabel: string; downLabel: string; upColor: string; downColor: string; lines?: RefLine[]; height?: number; digits?: number; tip?: (r: StrikeBar) => TipRow[]; signed?: boolean; paired?: boolean },
): void {
    host.replaceChildren();
    host.classList.add('chart');
    if (rows.length === 0) return;
    host.append(legend([{ label: opts.upLabel, color: opts.upColor }, { label: opts.downLabel, color: opts.downColor }]));
    const W = Math.max(320, host.clientWidth || 600);
    const H = opts.height ?? 260;
    const m = { l: 52, r: 12, t: opts.lines?.length ? 8 + REF_ROWS * REF_ROW_H : 10, b: 24 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
    const lo = rows[0]!.strike;
    const hi = rows[rows.length - 1]!.strike;
    const span = Math.max(hi - lo, 1e-9);
    const slot = iw / rows.length;
    const px = (k: number) => m.l + slot / 2 + ((k - lo) / span) * (iw - slot);
    const maxUp = Math.max(...rows.map((r) => Math.abs(r.up)), 0);
    const maxDown = Math.max(...rows.map((r) => Math.abs(r.down)), 0);
    const top = niceMax(Math.max(maxUp, maxDown, 1));
    const mid = m.t + ih / 2;
    const y = (v: number) => mid - (v / top) * (ih / 2);
    for (const v of [top, top / 2, 0, -top / 2, -top]) {
        svg.append(svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
        const t = svgEl('text', { class: 'axis', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
        t.textContent = compact(opts.signed ? v : Math.abs(v));
        svg.append(t);
    }
    const w = Math.max(1, Math.min(18, slot - 2));
    // Data ends rounded, anchored flat on the baseline (a square rect over the rounded one's base).
    const bar = (x: number, bw: number, v: number, fill: string) => {
        const rr = Math.min(4, bw / 2);
        const len = Math.abs(y(v) - mid) - 1;
        if (len <= 0) return;
        const top = v > 0 ? mid - 1 - len : mid + 1;
        svg.append(svgEl('rect', { x, y: top, width: bw, height: len, fill, rx: rr }));
        if (len > rr) svg.append(svgEl('rect', { x, y: v > 0 ? mid - 1 - rr : mid + 1, width: bw, height: rr, fill }));
    };
    for (const row of rows) {
        const x = px(row.strike);
        if (opts.paired) {
            // 2px surface gap between the pair.
            const bw = Math.max(1, (w - 2) / 2);
            bar(x - bw - 1, bw, row.up, opts.upColor);
            bar(x + 1, bw, row.down, opts.downColor);
        } else {
            bar(x - w / 2, w, Math.abs(row.up), opts.upColor);
            bar(x - w / 2, w, -Math.abs(row.down), opts.downColor);
        }
    }
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: mid, y2: mid, stroke: 'var(--text-muted)', 'stroke-width': 1 }));
    // Strike labels: about one per 70px.
    const every = Math.max(1, Math.ceil(70 / slot));
    rows.forEach((row, i) => {
        if (i % every !== 0) return;
        const t = svgEl('text', { class: 'axis', x: px(row.strike), y: H - 6, 'text-anchor': 'middle' });
        t.textContent = fmt(row.strike, row.strike % 1 ? 1 : 0);
        svg.append(t);
    });
    refLines(svg, opts.lines ?? [], px, lo - slot, hi + slot, m.t, m.t + ih);

    const hover = svgEl('rect', { y: m.t, height: ih, width: slot, fill: 'rgba(255,255,255,0.06)', visibility: 'hidden', 'pointer-events': 'none' });
    svg.append(hover);
    const hit = svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => {
        const b = svg.getBoundingClientRect();
        const x = ((ev.clientX - b.left) / b.width) * W;
        const i = Math.max(0, Math.min(rows.length - 1, Math.floor((x - m.l) / slot)));
        const row = rows[i]!;
        hover.setAttribute('x', String(px(row.strike) - slot / 2));
        hover.setAttribute('visibility', 'visible');
        const tipRows = opts.tip?.(row) ?? [
            { label: opts.upLabel, value: fmt(row.up, opts.digits ?? 0), color: opts.upColor },
            { label: opts.downLabel, value: fmt(row.down, opts.digits ?? 0), color: opts.downColor },
        ];
        showTip(ev.clientX, ev.clientY, `Strike ${fmt(row.strike, row.strike % 1 ? 2 : 0)}`, tipRows);
    });
    hit.addEventListener('pointerleave', () => {
        hover.setAttribute('visibility', 'hidden');
        hideTip();
    });
    svg.append(hit);
    host.append(svg);
}

export interface XYSeries {
    label: string;
    color: string;
    points: ReadonlyArray<readonly [number, number | null]>;
}

/** Lines over a numeric X axis with a snapping crosshair; one Y axis only. */
export function xyLines(
    host: HTMLElement,
    series: readonly XYSeries[],
    opts: { height?: number; xFmt: (v: number) => string; yFmt: (v: number) => string; xHead?: (v: number) => string; lines?: RefLine[]; zero?: boolean; fill?: boolean },
): void {
    host.replaceChildren();
    host.classList.add('chart');
    const all = series.flatMap((s) => s.points.filter((p): p is [number, number] => p[1] != null));
    if (all.length === 0) return;
    if (series.length > 1) host.append(legend(series.map((s) => ({ label: s.label, color: s.color }))));
    const W = Math.max(320, host.clientWidth || 600);
    const H = opts.height ?? 220;
    const m = { l: 52, r: 12, t: opts.lines?.length ? 8 + REF_ROWS * REF_ROW_H : 10, b: 24 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img' });
    const xs = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    const x0 = xs[0]!;
    const x1 = xs[xs.length - 1]!;
    let y0 = Math.min(...all.map((p) => p[1]));
    let y1 = Math.max(...all.map((p) => p[1]));
    if (opts.zero) {
        y0 = Math.min(y0, 0);
        y1 = Math.max(y1, 0);
    }
    if (y1 === y0) {
        y0 -= Math.abs(y0) * 0.1 || 1;
        y1 += Math.abs(y1) * 0.1 || 1;
    }
    // Round gridlines: a 1/2/2.5/5 step that gives four to six of them, the range snapped out to it.
    const step = niceStep((y1 - y0) / 4);
    y0 = Math.floor(y0 / step) * step;
    y1 = Math.ceil(y1 / step) * step;
    const px = (v: number) => m.l + (x1 === x0 ? iw / 2 : ((v - x0) / (x1 - x0)) * iw);
    const py = (v: number) => m.t + ih - ((v - y0) / (y1 - y0)) * ih;
    for (let v = y0; v <= y1 + step / 2; v += step) {
        svg.append(svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: py(v), y2: py(v) }));
        const t = svgEl('text', { class: 'axis', x: m.l - 6, y: py(v) + 4, 'text-anchor': 'end' });
        t.textContent = opts.yFmt(v);
        svg.append(t);
    }
    if (opts.zero && y0 < 0 && y1 > 0) svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: py(0), y2: py(0), stroke: 'var(--text-muted)', 'stroke-width': 1 }));
    for (let k = 0; k <= 4; k++) {
        const v = x0 + ((x1 - x0) * k) / 4;
        const t = svgEl('text', { class: 'axis', x: px(v), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === 4 ? 'end' : 'middle' });
        t.textContent = opts.xFmt(v);
        svg.append(t);
    }
    refLines(svg, opts.lines ?? [], px, x0, x1, m.t, m.t + ih);
    for (const s of series) {
        let d = '';
        let pen = false;
        const pts = [...s.points].sort((a, b) => a[0] - b[0]);
        for (const [x, y] of pts) {
            if (y == null) {
                pen = false;
                continue;
            }
            d += `${pen ? 'L' : 'M'}${px(x)},${py(y)}`;
            pen = true;
        }
        if (opts.fill && opts.zero && series.length === 1) {
            // A soft wash between the line and the zero line.
            const base = py(Math.max(y0, Math.min(0, y1)));
            const area = `${d}L${px(pts[pts.length - 1]![0])},${base}L${px(pts[0]![0])},${base}Z`;
            svg.append(svgEl('path', { d: area, fill: s.color, 'fill-opacity': 0.14 }));
        }
        svg.append(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    const cross = svgEl('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--text-muted)', 'stroke-dasharray': '3 3', visibility: 'hidden' });
    svg.append(cross);
    const dots = series.map((s) => {
        const c = svgEl('circle', { r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden', 'pointer-events': 'none' });
        svg.append(c);
        return c;
    });
    const hit = svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => {
        const b = svg.getBoundingClientRect();
        const xv = x0 + (((ev.clientX - b.left) / b.width) * W - m.l) / iw * (x1 - x0);
        const at = xs.reduce((a, v) => (Math.abs(v - xv) < Math.abs(a - xv) ? v : a), xs[0]!);
        cross.setAttribute('x1', String(px(at)));
        cross.setAttribute('x2', String(px(at)));
        cross.setAttribute('visibility', 'visible');
        const rows: TipRow[] = [];
        series.forEach((s, i) => {
            const p = s.points.find((q) => q[0] === at);
            const v = p?.[1] ?? null;
            dots[i]!.setAttribute('visibility', v == null ? 'hidden' : 'visible');
            if (v != null) {
                dots[i]!.setAttribute('cx', String(px(at)));
                dots[i]!.setAttribute('cy', String(py(v)));
            }
            rows.push({ label: s.label, value: v == null ? '—' : opts.yFmt(v), color: s.color });
        });
        showTip(ev.clientX, ev.clientY, (opts.xHead ?? opts.xFmt)(at), rows);
    });
    hit.addEventListener('pointerleave', () => {
        cross.setAttribute('visibility', 'hidden');
        for (const d of dots) d.setAttribute('visibility', 'hidden');
        hideTip();
    });
    svg.append(hit);
    host.append(svg);
}

function niceStep(raw: number): number {
    const p = 10 ** Math.floor(Math.log10(raw));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** 1234567 → 1.2M; keeps the sign. */
export function compact(v: number): string {
    const a = Math.abs(v);
    const s = v < 0 ? '−' : '';
    if (a >= 1e9) return `${s}${fmt(a / 1e9, a >= 1e10 ? 0 : 1)}B`;
    if (a >= 1e6) return `${s}${fmt(a / 1e6, a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e3) return `${s}${fmt(a / 1e3, a >= 1e4 ? 0 : 1)}K`;
    return `${s}${fmt(a, a < 10 && a % 1 ? 1 : 0)}`;
}
