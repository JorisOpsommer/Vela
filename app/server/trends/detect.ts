// Trend detection on one series (4h, Daily or Weekly), read the way a trader marks up a chart:
//   1. swings — the turning points that matter, sized by the market's own volatility (ATR);
//   2. support and resistance — price areas where several swings turned, scored by how many
//      times, how hard price bounced, how recently, and how rarely it sliced through;
//   3. trend lines — lines through rising lows or falling highs that no close has broken,
//      scored by their extra touches, their span and how recently price respected them;
//   4. the trend itself — the swing structure (higher highs and lows, or lower), the
//      position against the 50 and 200 averages, and the directional strength (ADX).
// Pure functions of settled bars: the same bars always give the same shapes.
import type { OHLCV } from '../market/types';

export type TrendTf = '240' | 'D' | 'W';
export type ShapeKind = 'support' | 'resistance' | 'trendline-up' | 'trendline-down';
export type ShapeStatus = 'holding' | 'testing' | 'broken';

export interface Anchor {
    time: number;
    price: number;
}

export interface TrendShape {
    /** Stable across runs while the shape's defining swings stay the same. */
    id: string;
    kind: ShapeKind;
    tf: TrendTf;
    /** Box: top-left and bottom-right corner (the right edge is the last bar; the box runs on). Line: its two swings. */
    anchors: [Anchor, Anchor];
    /** Swings that turned at the shape, anchors included. */
    touches: number;
    /** 0–100, comparable within a kind. */
    score: number;
    lastTouch: number;
    status: ShapeStatus;
    /** A level that also shows on the other timeframe. */
    confluence?: boolean;
}

export type TrendState = 'up' | 'down' | 'range';

export interface TrendRead {
    state: TrendState;
    /** 0–1: how clearly the swings, averages and ADX agree. */
    strength: number;
    adx: number | null;
    /** Close against the 50- and 200-bar averages. */
    aboveEma50: boolean | null;
    aboveEma200: boolean | null;
    structure: 'higher' | 'lower' | 'mixed' | null;
}

export type SignalKind = 'testing-support' | 'testing-resistance' | 'breakout' | 'breakdown' | 'trendline-break' | 'trendline-bounce';

export interface TrendSignal {
    kind: SignalKind;
    tf: TrendTf;
    shapeId: string;
    /** 0–100: the shape's score, weighted by how fresh the event is. */
    strength: number;
    at: number;
}

export interface Detection {
    tf: TrendTf;
    /** Open time of the newest settled bar the read used. */
    asOf: number;
    close: number;
    atr: number;
    trend: TrendRead;
    shapes: TrendShape[];
    signals: TrendSignal[];
}

interface Params {
    /** A swing needs a reversal of this many ATRs to count. */
    swingAtr: number;
    /** Bars either side a minor swing must top (bottom). */
    fractal: number;
    /** Bars read for levels and lines. */
    lookback: number;
    /** Recency half-life, in bars. */
    halfLife: number;
    /** Levels farther than this fraction from the close are left out. */
    maxDistance: number;
    /** Fewer settled bars than this read nothing. */
    minBars: number;
}

const PARAMS: Record<TrendTf, Params> = {
    W: { swingAtr: 2, fractal: 2, lookback: 400, halfLife: 120, maxDistance: 0.5, minBars: 80 },
    D: { swingAtr: 2.2, fractal: 3, lookback: 500, halfLife: 160, maxDistance: 0.3, minBars: 120 },
    '240': { swingAtr: 2.2, fractal: 4, lookback: 330, halfLife: 140, maxDistance: 0.15, minBars: 120 },
};
const ATR_LEN = 14;
const MAX_ZONES_PER_SIDE = 3;
const MAX_LINES_PER_SIDE = 2;
/** Price within this many ATRs of a level counts as testing it. */
const TEST_ATR = 0.5;
/** Levels closer than this many ATRs are one area: the stronger one stands for both. */
const ZONE_GAP_ATR = 0.8;
/** Shapes scoring under this (of the best of their kind) are noise next to the ones shown. */
const MIN_SCORE = 20;
/** A line touched only at its two swings needs this span (bars) to count. */
const TWO_TOUCH_SPAN = 20;
/** A break, breakout or bounce this many bars old still signals. */
const SIGNAL_BARS = 5;

// ── Indicators ──────────────────────────────────────────────────────────────

/** Wilder's ATR; entries before the first full window are null. */
export function atrSeries(bars: readonly OHLCV[], len = ATR_LEN): Array<number | null> {
    const out: Array<number | null> = [];
    let atr = 0;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close));
        if (i < len) {
            atr += tr / len;
            out.push(i === len - 1 ? atr : null);
        } else {
            atr = (atr * (len - 1) + tr) / len;
            out.push(atr);
        }
    }
    return out;
}

export function ema(values: readonly number[], len: number): Array<number | null> {
    const k = 2 / (len + 1);
    const out: Array<number | null> = [];
    let e = 0;
    for (let i = 0; i < values.length; i++) {
        if (i < len) {
            e += values[i]! / len;
            out.push(i === len - 1 ? e : null);
        } else {
            e = values[i]! * k + e * (1 - k);
            out.push(e);
        }
    }
    return out;
}

/** Wilder's ADX of the last bar, or null without enough history. */
export function adx(bars: readonly OHLCV[], len = 14): number | null {
    if (bars.length < len * 3) return null;
    let tr = 0;
    let pdm = 0;
    let ndm = 0;
    let dx = 0;
    let out: number | null = null;
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i]!;
        const p = bars[i - 1]!;
        const up = b.high - p.high;
        const down = p.low - b.low;
        const t = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
        const pd = up > down && up > 0 ? up : 0;
        const nd = down > up && down > 0 ? down : 0;
        if (i <= len) {
            tr += t;
            pdm += pd;
            ndm += nd;
        } else {
            tr = tr - tr / len + t;
            pdm = pdm - pdm / len + pd;
            ndm = ndm - ndm / len + nd;
        }
        if (i < len) continue;
        const pdi = tr > 0 ? (100 * pdm) / tr : 0;
        const ndi = tr > 0 ? (100 * ndm) / tr : 0;
        const d = pdi + ndi > 0 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
        if (i < len * 2) dx += d / len;
        else out = out == null ? dx : (out * (len - 1) + d) / len;
    }
    return out;
}

// ── Swings ──────────────────────────────────────────────────────────────────

export interface Swing {
    index: number;
    time: number;
    price: number;
    high: boolean;
    /** Largest move away from the swing before price came back, in ATRs (capped). */
    reaction: number;
}

/**
 * Major swings: a zigzag that confirms a high once price has fallen `k` ATRs from it (a
 * low once it has risen as far). The last, unconfirmed extreme is left out.
 */
export function zigzag(bars: readonly OHLCV[], atr: ReadonlyArray<number | null>, k: number): Swing[] {
    const out: Swing[] = [];
    let dir: 1 | -1 | 0 = 0;
    let ext = 0;
    for (let i = 1; i < bars.length; i++) {
        const a = atr[i] ?? atr.find((v) => v != null) ?? 0;
        const b = bars[i]!;
        if (dir === 0) {
            if (b.high > bars[ext]!.high && b.low >= bars[ext]!.low) ext = i;
            if (bars[ext]!.high - b.low > k * a) {
                out.push(swing(bars, atr, ext, true));
                dir = -1;
                ext = i;
            } else if (b.high - bars[ext]!.low > k * a) {
                out.push(swing(bars, atr, ext, false));
                dir = 1;
                ext = i;
            }
            continue;
        }
        if (dir === 1) {
            if (b.high >= bars[ext]!.high) ext = i;
            else if (bars[ext]!.high - b.low > k * a) {
                out.push(swing(bars, atr, ext, true));
                dir = -1;
                ext = i;
            }
        } else {
            if (b.low <= bars[ext]!.low) ext = i;
            else if (b.high - bars[ext]!.low > k * a) {
                out.push(swing(bars, atr, ext, false));
                dir = 1;
                ext = i;
            }
        }
    }
    return out;
}

/** Minor swings: a bar whose high (low) tops (bottoms) the `n` bars either side. */
export function fractals(bars: readonly OHLCV[], atr: ReadonlyArray<number | null>, n: number): Swing[] {
    const out: Swing[] = [];
    for (let i = n; i < bars.length - n; i++) {
        let hi = true;
        let lo = true;
        for (let j = i - n; j <= i + n && (hi || lo); j++) {
            if (j === i) continue;
            if (bars[j]!.high >= bars[i]!.high) hi = false;
            if (bars[j]!.low <= bars[i]!.low) lo = false;
        }
        if (hi) out.push(swing(bars, atr, i, true));
        if (lo) out.push(swing(bars, atr, i, false));
    }
    return out;
}

function swing(bars: readonly OHLCV[], atr: ReadonlyArray<number | null>, i: number, high: boolean): Swing {
    const b = bars[i]!;
    const a = atr[i] ?? atr.find((v) => v != null) ?? Math.max(b.high - b.low, 1e-9);
    // The reaction: how far price travelled away within the next 20 bars, before retaking the swing.
    let best = 0;
    for (let j = i + 1; j < Math.min(bars.length, i + 21); j++) {
        const x = bars[j]!;
        if (high ? x.high > b.high : x.low < b.low) break;
        best = Math.max(best, high ? b.high - x.low : x.high - b.low);
    }
    return { index: i, time: b.time, price: high ? b.high : b.low, high, reaction: Math.min(best / a, 6) };
}

// ── Levels ──────────────────────────────────────────────────────────────────

interface Zone {
    top: number;
    bottom: number;
    members: Swing[];
    score: number;
    crosses: number;
}

/** Group swing prices lying within `tol` of the group's running center (single pass, sorted by price). */
function cluster(swings: readonly Swing[], tol: number): Swing[][] {
    const sorted = [...swings].sort((a, b) => a.price - b.price);
    const groups: Swing[][] = [];
    let cur: Swing[] = [];
    let sum = 0;
    for (const s of sorted) {
        if (cur.length > 0 && s.price - sum / cur.length > tol) {
            groups.push(cur);
            cur = [];
            sum = 0;
        }
        cur.push(s);
        sum += s.price;
    }
    if (cur.length > 0) groups.push(cur);
    return groups;
}

/** Times the close went from one side of [bottom, top] to the other. */
function crossings(bars: readonly OHLCV[], from: number, bottom: number, top: number): number {
    let side = 0;
    let n = 0;
    for (let i = from; i < bars.length; i++) {
        const c = bars[i]!.close;
        const s = c > top ? 1 : c < bottom ? -1 : 0;
        if (s === 0) continue;
        if (side !== 0 && s !== side) n += 1;
        side = s;
    }
    return n;
}

function zones(bars: readonly OHLCV[], swings: readonly Swing[], atrNow: number, p: Params): Zone[] {
    const last = bars.length - 1;
    const from = Math.max(0, bars.length - p.lookback);
    const close = bars[last]!.close;
    const recent = swings.filter((s) => s.index >= from && Math.abs(s.price - close) / close <= p.maxDistance * 1.1);
    const out: Zone[] = [];
    for (const members of cluster(recent, 0.55 * atrNow)) {
        if (members.length < 2) continue;
        const weight = (s: Swing) => Math.min(s.reaction, 4) * Math.pow(0.5, (last - s.index) / p.halfLife);
        const total = members.reduce((a, s) => a + weight(s), 0);
        const center = members.reduce((a, s) => a + s.price * weight(s), 0) / Math.max(total, 1e-9);
        const spread = Math.sqrt(members.reduce((a, s) => a + (s.price - center) ** 2, 0) / members.length);
        const half = Math.min(Math.max(spread, 0.2 * atrNow), 0.6 * atrNow);
        const top = center + half;
        const bottom = center - half;
        const firstIndex = Math.min(...members.map((s) => s.index));
        const cross = crossings(bars, firstIndex, bottom, top);
        // Strong reactions from a few swings, or many touches: either earns a level.
        const reactions = members.reduce((a, s) => a + Math.min(s.reaction, 4), 0);
        if (members.length < 3 && reactions < 5) continue;
        const score = (total * Math.sqrt(members.length)) / (1 + 0.3 * cross);
        out.push({ top, bottom, members, score, crosses: cross });
    }
    return out;
}

// ── Lines ───────────────────────────────────────────────────────────────────

interface Line {
    a: Swing;
    b: Swing;
    touches: Swing[];
    score: number;
    /** Index of the first close through the line after its second anchor, if any. */
    brokeAt: number | null;
    lastTouch: number;
}

/** Log-price line through two swings, read at bar `i`. */
function lineAt(a: Swing, b: Swing, i: number): number {
    const la = Math.log(a.price);
    const lb = Math.log(b.price);
    return Math.exp(la + ((lb - la) * (i - a.index)) / (b.index - a.index));
}

function trendLines(bars: readonly OHLCV[], major: readonly Swing[], minor: readonly Swing[], atr: ReadonlyArray<number | null>, up: boolean, p: Params): Line[] {
    const last = bars.length - 1;
    const from = Math.max(0, bars.length - p.lookback);
    const atrNow = atr[last] ?? 0;
    const anchors = major.filter((s) => s.high !== up && s.index >= from).slice(-10);
    const touchPool = [...new Map([...major, ...minor].filter((s) => s.high !== up && s.index >= from).map((s) => [s.index, s])).values()];
    const out: Line[] = [];
    for (let i = 0; i < anchors.length; i++) {
        for (let j = i + 1; j < anchors.length; j++) {
            const a = anchors[i]!;
            const b = anchors[j]!;
            // Rising lows under an up line, falling highs over a down line.
            if (up ? b.price <= a.price : b.price >= a.price) continue;
            if (b.index - a.index < 8) continue;
            // A slope steeper than about one ATR a bar is a spike, not a trend.
            const perBar = Math.abs(b.price - a.price) / (b.index - a.index);
            if (perBar > 0.8 * atrNow) continue;
            let ok = true;
            let brokeAt: number | null = null;
            for (let k = a.index + 1; k <= last && ok; k++) {
                const v = lineAt(a, b, k);
                const tol = 0.25 * (atr[k] ?? atrNow);
                const c = bars[k]!.close;
                const through = up ? c < v - tol : c > v + tol;
                if (!through) continue;
                if (k <= b.index) ok = false;
                else {
                    brokeAt = k;
                    break;
                }
            }
            if (!ok) continue;
            const end = brokeAt ?? last;
            const touches = touchPool.filter((s) => s.index >= a.index && s.index <= end && Math.abs(s.price - lineAt(a, b, s.index)) <= 0.35 * (atr[s.index] ?? atrNow));
            // Swings closer than three bars are one touch.
            const distinct = touches.sort((x, y) => x.index - y.index).filter((s, k, arr) => k === 0 || s.index - arr[k - 1]!.index >= 3);
            if (distinct.length < 2 || (distinct.length === 2 && b.index - a.index < TWO_TOUCH_SPAN)) continue;
            const lastTouch = distinct[distinct.length - 1]!.index;
            const span = Math.min((end - a.index) / 60, 2.5);
            const recency = Math.pow(0.5, (last - lastTouch) / p.halfLife);
            const reach = Math.abs(lineAt(a, b, last) - bars[last]!.close) / Math.max(atrNow, 1e-9);
            const near = reach <= 8 ? 1 : 8 / reach;
            const score = Math.pow(distinct.length, 1.6) * (0.5 + span) * recency * near;
            out.push({ a, b, touches: distinct, score, brokeAt, lastTouch: bars[lastTouch]!.time });
        }
    }
    // Near-duplicates (the same line drawn off neighboring swings): keep the best.
    out.sort((x, y) => y.score - x.score);
    const kept: Line[] = [];
    for (const l of out) {
        const v = lineAt(l.a, l.b, last);
        const dup = kept.some((k) => Math.abs(lineAt(k.a, k.b, last) - v) < 1.2 * atrNow || k.a === l.a || k.b === l.b);
        if (!dup) kept.push(l);
    }
    return kept;
}

// ── The read ────────────────────────────────────────────────────────────────

function trendState(bars: readonly OHLCV[], major: readonly Swing[], atrNow: number): TrendRead {
    const closes = bars.map((b) => b.close);
    const e50s = ema(closes, 50);
    const e50 = e50s.at(-1) ?? null;
    const e50then = e50s.at(-51) ?? null;
    const e200 = ema(closes, 200).at(-1) ?? null;
    const close = closes[closes.length - 1]!;
    const highs = major.filter((s) => s.high).slice(-2);
    const lows = major.filter((s) => !s.high).slice(-2);
    let structure: TrendRead['structure'] = null;
    if (highs.length === 2 && lows.length === 2) {
        // Swings within a quarter ATR of each other are the same level: neither higher nor lower.
        const tol = 0.25 * atrNow;
        const dh = highs[1]!.price - highs[0]!.price;
        const dl = lows[1]!.price - lows[0]!.price;
        structure = dh > tol && dl > tol ? 'higher' : dh < -tol && dl < -tol ? 'lower' : 'mixed';
    }
    const a = adx(bars);
    let vote = 0;
    if (structure === 'higher') vote += 2;
    if (structure === 'lower') vote -= 2;
    if (e50 != null) vote += close > e50 ? 1 : -1;
    if (e200 != null) vote += close > e200 ? 1 : -1;
    // Flat averages say nothing: they vote only when clearly apart, or clearly sloping over their own window.
    if (e50 != null && e200 != null && Math.abs(e50 - e200) > 0.5 * atrNow) vote += e50 > e200 ? 1 : -1;
    if (e50 != null && e50then != null && Math.abs(e50 - e50then) > atrNow) vote += e50 > e50then ? 1 : -1;
    const trending = a == null || a >= 18;
    const state: TrendState = trending && vote >= 3 ? 'up' : trending && vote <= -3 ? 'down' : 'range';
    const strength = state === 'range' ? Math.max(0, 1 - Math.abs(vote) / 6) * 0.5 : Math.min(1, (Math.abs(vote) / 6) * (a == null ? 0.7 : Math.min(1, a / 35)));
    return { state, strength: Math.round(strength * 100) / 100, adx: a, aboveEma50: e50 == null ? null : close > e50, aboveEma200: e200 == null ? null : close > e200, structure };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** Detect levels, lines, trend and signals on settled bars (oldest first). Null when the history is too short. */
export function detect(bars: readonly OHLCV[], tf: TrendTf): Detection | null {
    const p = PARAMS[tf];
    if (bars.length < p.minBars) return null;
    const atr = atrSeries(bars);
    const last = bars.length - 1;
    const atrNow = atr[last]!;
    const close = bars[last]!.close;
    const lastTime = bars[last]!.time;
    const major = zigzag(bars, atr, p.swingAtr);
    const minor = fractals(bars, atr, p.fractal);
    const trend = trendState(bars, major, atrNow);
    const shapes: TrendShape[] = [];
    const signals: TrendSignal[] = [];
    const maxScore = { zone: 0, line: 0 };

    // Levels: every swing votes; the zone's side is where price sits now.
    const all = [...new Map([...major, ...minor].map((s) => [`${s.index}${s.high}`, s])).values()];
    const zs = zones(bars, all, atrNow, p).sort((a, b) => b.score - a.score);
    maxScore.zone = zs[0]?.score ?? 1;
    const picked: Zone[] = [];
    for (const z of zs) {
        if (100 * z.score < MIN_SCORE * maxScore.zone) break;
        if (picked.some((q) => z.bottom <= q.top + ZONE_GAP_ATR * atrNow && z.top >= q.bottom - ZONE_GAP_ATR * atrNow)) continue;
        picked.push(z);
    }
    const supports = picked.filter((z) => z.bottom < close && (z.top < close || prevSide(bars, z) > 0)).sort((a, b) => b.top - a.top);
    const resists = picked.filter((z) => !supports.includes(z)).sort((a, b) => a.bottom - b.bottom);
    const keepZones = (list: Zone[]) =>
        list
            .filter((z) => Math.abs((z.top + z.bottom) / 2 - close) / close <= p.maxDistance)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_ZONES_PER_SIDE);
    for (const [kind, list] of [['support', keepZones(supports)], ['resistance', keepZones(resists)]] as const) {
        for (const z of list) {
            const first = Math.min(...z.members.map((s) => s.index));
            const lastMember = Math.max(...z.members.map((s) => s.index));
            const testing = kind === 'support' ? close <= z.top + TEST_ATR * atrNow : close >= z.bottom - TEST_ATR * atrNow;
            // A level is known by its oldest swing: its center drifts as weights age, and its
            // side flips when price crosses it, but that swing stays put.
            const id = `${tf}-level-${bars[first]!.time}`;
            const score = Math.round((100 * z.score) / maxScore.zone);
            shapes.push({
                id,
                kind,
                tf,
                anchors: [
                    { time: bars[first]!.time, price: round(z.top) },
                    { time: lastTime, price: round(z.bottom) },
                ],
                touches: z.members.length,
                score,
                lastTouch: bars[lastMember]!.time,
                status: testing ? 'testing' : 'holding',
            });
            if (testing) signals.push({ kind: kind === 'support' ? 'testing-support' : 'testing-resistance', tf, shapeId: id, strength: score, at: lastTime });
            // A close through the zone within the last few bars, from the other side.
            const flip = recentCross(bars, z, SIGNAL_BARS);
            if (flip && kind === 'support' && flip.dir > 0) signals.push({ kind: 'breakout', tf, shapeId: id, strength: Math.round(score * fresh(flip.ago)), at: bars[last - flip.ago]!.time });
            if (flip && kind === 'resistance' && flip.dir < 0) signals.push({ kind: 'breakdown', tf, shapeId: id, strength: Math.round(score * fresh(flip.ago)), at: bars[last - flip.ago]!.time });
        }
    }

    // Lines: support under rising lows, resistance over falling highs.
    for (const up of [true, false]) {
        const lines = trendLines(bars, major, minor, atr, up, p);
        const live = lines.filter((l) => l.brokeAt == null || last - l.brokeAt <= SIGNAL_BARS).filter((l, _, arr) => 100 * l.score >= MIN_SCORE * arr[0]!.score);
        maxScore.line = Math.max(maxScore.line, live[0]?.score ?? 0);
        for (const l of live.slice(0, MAX_LINES_PER_SIDE)) {
            const kind = up ? 'trendline-up' : 'trendline-down';
            const id = `${tf}-${kind}-${l.a.time}-${l.b.time}`;
            const v = lineAt(l.a, l.b, last);
            const status: ShapeStatus = l.brokeAt != null ? 'broken' : Math.abs(close - v) <= TEST_ATR * atrNow ? 'testing' : 'holding';
            const score = Math.round((100 * l.score) / Math.max(live[0]!.score, 1e-9));
            shapes.push({ id, kind, tf, anchors: [{ time: l.a.time, price: round(l.a.price) }, { time: l.b.time, price: round(l.b.price) }], touches: l.touches.length, score, lastTouch: l.lastTouch, status });
            if (status === 'broken') signals.push({ kind: 'trendline-break', tf, shapeId: id, strength: Math.round(score * fresh(last - l.brokeAt!)), at: bars[l.brokeAt!]!.time });
            else if (status === 'testing') signals.push({ kind: 'trendline-bounce', tf, shapeId: id, strength: score, at: lastTime });
        }
    }
    signals.sort((a, b) => b.strength - a.strength);
    return { tf, asOf: lastTime, close, atr: round(atrNow), trend, shapes, signals };
}

/** Which side of the zone price came from before it last entered: 1 above, −1 below, 0 never outside. */
function prevSide(bars: readonly OHLCV[], z: Zone): number {
    for (let i = bars.length - 1; i >= 0; i--) {
        const c = bars[i]!.close;
        if (c > z.top) return 1;
        if (c < z.bottom) return -1;
    }
    return 0;
}

/** The most recent close crossing the zone within `n` bars: its direction and age. */
function recentCross(bars: readonly OHLCV[], z: Zone, n: number): { dir: 1 | -1; ago: number } | null {
    const last = bars.length - 1;
    for (let ago = 0; ago < n; ago++) {
        const now = bars[last - ago]!.close;
        if (now <= z.top && now >= z.bottom) continue;
        // Look back past any closes inside the zone for the side it came from.
        for (let k = last - ago - 1; k >= Math.max(0, last - ago - 10); k--) {
            const c = bars[k]!.close;
            if (c > z.top || c < z.bottom) {
                const before = c > z.top ? 1 : -1;
                const after = now > z.top ? 1 : -1;
                if (before !== after) return { dir: after, ago };
                break;
            }
        }
    }
    return null;
}

function fresh(ago: number): number {
    return 1 - (0.5 * ago) / SIGNAL_BARS;
}

/** Mark levels that overlap a level of the other timeframe. */
export function markConfluence(a: Detection | null, b: Detection | null): void {
    if (!a || !b) return;
    const boxes = (d: Detection) => d.shapes.filter((s) => s.kind === 'support' || s.kind === 'resistance');
    for (const x of boxes(a)) {
        for (const y of boxes(b)) {
            const [xt, xb] = [x.anchors[0].price, x.anchors[1].price];
            const [yt, yb] = [y.anchors[0].price, y.anchors[1].price];
            if (xb <= yt && xt >= yb) {
                x.confluence = true;
                y.confluence = true;
            }
        }
    }
}
