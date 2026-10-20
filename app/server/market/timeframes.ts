// Timeframe vocabulary shared by every bridge: Vela's canonical strings (a bare number
// is minutes, `D`/`W`/`M` named periods, optional multiplier `2D`, `3M`) parsed once, plus
// time-zone-aware bucketing so aggregated bars line up with the venue's own calendar.
import type { OHLCV } from './types';

export type TfUnit = 'minute' | 'day' | 'week' | 'month';

export interface Timeframe {
    unit: TfUnit;
    /** Multiplier: minutes for `minute`, else days/weeks/months. */
    n: number;
}

const ALIASES: Record<string, string> = { '1h': '60', '2h': '120', '3h': '180', '4h': '240', '6h': '360', '8h': '480', '12h': '720', '1d': 'D', '1w': 'W', '1mo': 'M' };

export function parseTimeframe(raw: string): Timeframe | null {
    const tf = (ALIASES[raw.trim().toLowerCase()] ?? raw).trim();
    let m = /^(\d+)$/.exec(tf);
    if (m) {
        const n = Number(m[1]);
        return n >= 1 && n <= 1440 ? { unit: 'minute', n } : null;
    }
    m = /^(\d*)([DWM])$/i.exec(tf);
    if (m) {
        const n = m[1] ? Number(m[1]) : 1;
        if (n < 1 || n > 12) return null;
        const u = m[2]!.toUpperCase();
        return { unit: u === 'D' ? 'day' : u === 'W' ? 'week' : 'month', n };
    }
    m = /^(\d+)m$/.exec(tf);
    if (m) return parseTimeframe(m[1]!);
    return null;
}

/** Nominal duration (months as 30 days) — window sizing only, never bucketing. */
export function nominalMs(tf: Timeframe): number {
    const day = 86_400_000;
    switch (tf.unit) {
        case 'minute':
            return tf.n * 60_000;
        case 'day':
            return tf.n * day;
        case 'week':
            return tf.n * 7 * day;
        case 'month':
            return tf.n * 30 * day;
    }
}

const offsetCache = new Map<string, number>();
const formatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset (ms, east-positive) of `timeZone` at instant `t`. */
export function tzOffsetMs(timeZone: string, t: number): number {
    if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0;
    const hourKey = `${timeZone}|${Math.floor(t / 3_600_000)}`;
    const hit = offsetCache.get(hourKey);
    if (hit !== undefined) return hit;
    let fmt = formatters.get(timeZone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        formatters.set(timeZone, fmt);
    }
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
    const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    const off = asUtc - Math.floor(t / 1000) * 1000;
    if (offsetCache.size > 50_000) offsetCache.clear();
    offsetCache.set(hourKey, off);
    return off;
}

const DAY_MS = 86_400_000;

/** Local calendar fields of instant `t` in `timeZone` (month 0-based, weekday 0 = Sunday). */
function localParts(timeZone: string, t: number): { y: number; m: number; d: number; wd: number } {
    const local = new Date(t + tzOffsetMs(timeZone, t));
    return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), wd: local.getUTCDay() };
}

/** The UTC instant of wall time `msOfDay` on local calendar date y-m-d (Date.UTC overflow rules apply). */
export function zonedWallTime(timeZone: string, y: number, m: number, d: number, msOfDay: number): number {
    const guess = Date.UTC(y, m, d) + msOfDay;
    return guess - tzOffsetMs(timeZone, guess - tzOffsetMs(timeZone, guess));
}

/** The UTC instant of local midnight on calendar date y-m-d. */
export function zonedMidnight(timeZone: string, y: number, m: number, d: number): number {
    return zonedWallTime(timeZone, y, m, d, 0);
}

/** Wall-clock midnight of the local date containing `t`, as a UTC instant. */
export function localMidnight(timeZone: string, t: number): number {
    const p = localParts(timeZone, t);
    return zonedMidnight(timeZone, p.y, p.m, p.d);
}

/** Milliseconds since local midnight of instant `t`. */
export function localTimeOfDay(timeZone: string, t: number): number {
    return t - localMidnight(timeZone, t);
}

/** `YYYY-MM-DD` of instant `t` in `timeZone`. */
export function localDate(timeZone: string, t: number): string {
    return new Date(t + tzOffsetMs(timeZone, t)).toISOString().slice(0, 10);
}

/**
 * Bucket open-time containing `t` for `tf`, aligned to `timeZone`'s calendar. Sub-daily
 * buckets restart each local day at `anchorMs` after midnight (a session open such as
 * 09:30), so a 4h bar never straddles days and hourly bars start on the open.
 */
export function bucketStart(tf: Timeframe, t: number, timeZone: string, anchorMs = 0): number {
    const p = localParts(timeZone, t);
    if (tf.unit === 'minute') {
        const size = tf.n * 60_000;
        if (size >= DAY_MS) return zonedMidnight(timeZone, p.y, p.m, p.d);
        const start = zonedWallTime(timeZone, p.y, p.m, p.d, anchorMs);
        return start + Math.floor((t - start) / size) * size;
    }
    if (tf.unit === 'day') {
        const days = Math.floor(Date.UTC(p.y, p.m, p.d) / DAY_MS);
        const start = new Date((days - (days % tf.n)) * DAY_MS);
        return zonedMidnight(timeZone, start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    }
    if (tf.unit === 'week') {
        const mondayDays = Math.floor(Date.UTC(p.y, p.m, p.d - ((p.wd + 6) % 7)) / DAY_MS);
        // Epoch day 0 was a Thursday: Monday-based week index = floor((days + 3) / 7).
        const week = Math.floor((mondayDays + 3) / 7);
        const start = new Date(((week - (week % tf.n)) * 7 - 3) * DAY_MS);
        return zonedMidnight(timeZone, start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    }
    const monthIndex = p.y * 12 + p.m;
    const start = monthIndex - (monthIndex % tf.n);
    return zonedMidnight(timeZone, Math.floor(start / 12), start % 12, 1);
}

/** Fold ascending bars into `tf` buckets (time = bucket open). Volume sums; a bar whose
 *  volume is unknown contributes nothing. */
export function aggregate(bars: readonly OHLCV[], tf: Timeframe, timeZone: string, anchorMs = 0): OHLCV[] {
    const out: OHLCV[] = [];
    let cur: OHLCV | null = null;
    for (const b of bars) {
        const key = bucketStart(tf, b.time, timeZone, anchorMs);
        if (!cur || cur.time !== key) {
            cur = { time: key, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
            out.push(cur);
        } else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
    }
    return out;
}

/** Sort by open-time, drop duplicates (later wins), drop non-finite rows. */
export function normalizeBars(bars: readonly OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) {
        if (![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
        byTime.set(b.time, b);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Keep bars inside `[from, to]` and at most the newest `limit`. */
export function clip(bars: OHLCV[], range: { from?: number; to?: number; limit?: number }): OHLCV[] {
    let out = bars;
    if (range.from != null || range.to != null) {
        const from = range.from ?? -Infinity;
        const to = range.to ?? Infinity;
        out = out.filter((b) => b.time >= from && b.time <= to);
    }
    if (range.limit != null && out.length > range.limit) out = out.slice(out.length - range.limit);
    return out;
}
