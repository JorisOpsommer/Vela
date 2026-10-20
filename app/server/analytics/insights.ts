// Per-user browsing analytics: the app reports what a signed-in user opens and how long
// they look at it; this module stores those events and turns them into the Insights page.
import type { Db } from '../db';
import type { Catalog } from '../market/catalog';
import { localDate, tzOffsetMs } from '../market/timeframes';
import type { RelatedMap, Suggestion } from './related';

export const EVENT_KINDS = ['open', 'tf', 'ind', 'style', 'layout', 'watch', 'wl'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface IncomingEvent {
    k: EventKind;
    v: string;
    x?: string;
    n?: number;
    t?: number;
}

const VALUE_RE = /^[A-Za-z0-9._:^=/ -]{1,40}$/;
const RETENTION_MS = 365 * 86_400_000;
const DAY_MS = 86_400_000;
/** Interest decays with a 30-day half-life, so the profile follows what the user does now. */
const HALF_LIFE_MS = 30 * DAY_MS;

/** Validate and store a batch. Returns how many were accepted. */
export function recordEvents(db: Db, userId: number, raw: unknown, now = Date.now()): number {
    if (!Array.isArray(raw)) return 0;
    const insert = db.prepare('INSERT INTO analytics_events (user_id, ts, kind, value, extra, n) VALUES (?, ?, ?, ?, ?, ?)');
    let accepted = 0;
    db.exec('BEGIN');
    try {
        for (const e of raw.slice(0, 200) as Array<Partial<IncomingEvent>>) {
            if (!e || typeof e !== 'object' || !EVENT_KINDS.includes(e.k as EventKind)) continue;
            if (typeof e.v !== 'string' || !VALUE_RE.test(e.v)) continue;
            const extra = typeof e.x === 'string' && VALUE_RE.test(e.x) ? e.x : null;
            const n = typeof e.n === 'number' && Number.isFinite(e.n) ? Math.min(Math.max(e.n, 0), 10) : 1;
            // Client clocks drift and queues can be old; never accept the future or ancient history.
            const ts = typeof e.t === 'number' && e.t <= now + 60_000 && e.t > now - 7 * DAY_MS ? Math.min(e.t, now) : now;
            const value = e.k === 'open' || e.k === 'watch' || e.k === 'wl' ? bare(e.v) : e.v;
            insert.run(userId, ts, e.k as EventKind, value, extra, n);
            accepted += 1;
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    if (Math.random() < 0.02) db.prepare('DELETE FROM analytics_events WHERE ts < ?').run(now - RETENTION_MS);
    return accepted;
}

export function clearEvents(db: Db, userId: number): void {
    db.prepare('DELETE FROM analytics_events WHERE user_id = ?').run(userId);
}

function bare(s: string): string {
    const i = s.lastIndexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toUpperCase();
}

interface Row {
    ts: number;
    kind: EventKind;
    value: string;
    extra: string | null;
    n: number;
}

const TF_LABELS: Record<string, string> = { '1': '1m', '2': '2m', '3': '3m', '5': '5m', '10': '10m', '15': '15m', '30': '30m', '45': '45m', '60': '1h', '120': '2h', '180': '3h', '240': '4h', '360': '6h', '480': '8h', '720': '12h', D: '1D', '2D': '2D', '3D': '3D', W: '1W', '2W': '2W', M: '1M' };

export function tfLabel(tf: string): string {
    return TF_LABELS[tf] ?? tf;
}

function tfMinutes(tf: string): number {
    if (/^\d+$/.test(tf)) return Number(tf);
    const m = /^(\d*)([DWM])$/.exec(tf);
    if (!m) return 1440;
    const n = m[1] ? Number(m[1]) : 1;
    return n * (m[2] === 'D' ? 1440 : m[2] === 'W' ? 10080 : 43200);
}

const ACRONYMS = new Set(['rsi', 'macd', 'vwap', 'atr', 'adx', 'obv', 'cci', 'mfi', 'roc', 'trix', 'kst', 'ppo', 'pvo', 'lsma', 'zlema', 'vidya', 'rma', 'sar', 'ttm', 'smi', 'vpvr']);

export function indicatorLabel(type: string): string {
    if (type === 'moving-average') return 'Moving Average';
    return type
        .split('-')
        .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

function countTop(map: Map<string, number>, limit: number): Array<{ key: string; value: number }> {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, value]) => ({ key, value: Math.round(value * 10) / 10 }));
}

function add(map: Map<string, number>, key: string, n: number): void {
    map.set(key, (map.get(key) ?? 0) + n);
}

export interface Badge {
    id: string;
    title: string;
    detail: string;
}

/** Everything the Insights page shows, from the user's events. */
export function buildInsights(opts: {
    db: Db;
    userId: number;
    tz: string;
    catalog: Catalog;
    related: RelatedMap;
    watchlist: string[];
    now?: number;
}) {
    const now = opts.now ?? Date.now();
    const rows = opts.db.prepare('SELECT ts, kind, value, extra, n FROM analytics_events WHERE user_id = ? AND ts >= ? ORDER BY ts').all(opts.userId, now - RETENTION_MS) as unknown as Row[];
    const tz = opts.tz;

    const opens = new Map<string, number>();
    const minutes = new Map<string, number>();
    const tfUse = new Map<string, number>();
    const indicators = new Map<string, number>();
    const styles = new Map<string, number>();
    const layouts = new Map<string, number>();
    const interest = new Map<string, number>();
    const heat: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const days = new Map<string, { opens: number; minutes: number }>();
    let totalOpens = 0;
    let totalMinutes = 0;

    for (const r of rows) {
        const decay = Math.pow(0.5, (now - r.ts) / HALF_LIFE_MS);
        const local = new Date(r.ts + tzOffsetMs(tz, r.ts));
        const day = localDate(tz, r.ts);
        const d = days.get(day) ?? { opens: 0, minutes: 0 };
        days.set(day, d);
        switch (r.kind) {
            case 'open':
                totalOpens += 1;
                add(opens, r.value, 1);
                add(interest, r.value, decay);
                if (r.extra) add(tfUse, r.extra, 1);
                heat[local.getUTCDay()]![local.getUTCHours()]! += 1;
                d.opens += 1;
                break;
            case 'watch':
                totalMinutes += r.n;
                add(minutes, r.value, r.n);
                add(interest, r.value, 0.2 * r.n * decay);
                if (r.extra) add(tfUse, r.extra, 0.2 * r.n);
                heat[local.getUTCDay()]![local.getUTCHours()]! += 0.2 * r.n;
                d.minutes += r.n;
                break;
            case 'tf':
                add(tfUse, r.value, 1);
                break;
            case 'ind':
                add(indicators, r.value, 1);
                break;
            case 'style':
                add(styles, r.value, 1);
                break;
            case 'layout':
                add(layouts, r.value, 1);
                break;
            case 'wl':
                add(interest, r.value, 2 * decay);
                break;
        }
    }

    // The watchlist is a standing statement of interest, even before any browsing.
    for (const s of opts.watchlist) add(interest, s, 0.15);

    const topSymbols = [...new Set([...opens.keys(), ...minutes.keys()])]
        .map((symbol) => {
            const e = opts.catalog.resolve(symbol);
            const rel = opts.related.get(symbol);
            return { symbol, name: rel?.n ?? e?.name ?? symbol, cls: e?.class ?? 'stock', sector: rel?.s ?? null, opens: opens.get(symbol) ?? 0, minutes: Math.round(minutes.get(symbol) ?? 0) };
        })
        .sort((a, b) => b.opens + b.minutes * 0.5 - (a.opens + a.minutes * 0.5))
        .slice(0, 12);

    const classMix = new Map<string, number>();
    const sectorMix = new Map<string, number>();
    for (const [sym, w] of interest) {
        const e = opts.catalog.resolve(sym);
        add(classMix, e?.class ?? 'stock', w);
        add(sectorMix, opts.related.get(sym)?.s ?? (e?.class === 'crypto' ? 'Crypto' : 'Other'), w);
    }

    // Streaks over local calendar days.
    const activeDays = [...days.keys()].sort();
    let longest = 0;
    let run = 0;
    let prev: string | null = null;
    for (const d of activeDays) {
        run = prev && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`) === DAY_MS ? run + 1 : 1;
        longest = Math.max(longest, run);
        prev = d;
    }
    const today = localDate(tz, now);
    const yesterday = localDate(tz, now - DAY_MS);
    let current = 0;
    if (days.has(today) || days.has(yesterday)) {
        for (let t = days.has(today) ? now : now - DAY_MS; days.has(localDate(tz, t)); t -= DAY_MS) current += 1;
    }

    const last30 = [];
    for (let i = 29; i >= 0; i--) {
        const d = localDate(tz, now - i * DAY_MS);
        const v = days.get(d);
        last30.push({ day: d, opens: v?.opens ?? 0, minutes: Math.round(v?.minutes ?? 0) });
    }

    let peakHour = -1;
    let peakVal = 0;
    for (let h = 0; h < 24; h++) {
        const v = heat.reduce((a, row) => a + row[h]!, 0);
        if (v > peakVal) [peakVal, peakHour] = [v, h];
    }

    const exclude = new Set([...opens.keys(), ...opts.watchlist]);
    // Ask for extra, then drop anything no longer listed (the map is hand-maintained).
    const suggestions: Suggestion[] = opts.related.suggest(interest, exclude, 18).filter((s) => opts.catalog.isListed(s.symbol)).slice(0, 12);
    const topInterest = [...interest.entries()].filter(([s]) => opts.related.get(s)).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const because = topInterest.map(([sym]) => ({
        symbol: sym,
        name: opts.related.get(sym)!.n,
        peers: opts.related
            .peersOf(sym)
            .filter((p) => !exclude.has(p) && opts.catalog.isListed(p))
            .slice(0, 5)
            .map((p) => ({ symbol: p, name: opts.related.get(p)!.n })),
    }));

    const tfTop = countTop(tfUse, 8).map((r) => ({ ...r, label: tfLabel(r.key) }));
    return {
        generatedAt: now,
        since: rows[0]?.ts ?? null,
        totals: {
            opens: totalOpens,
            minutes: Math.round(totalMinutes),
            symbols: new Set([...opens.keys(), ...minutes.keys()]).size,
            activeDays: activeDays.length,
            currentStreak: current,
            longestStreak: longest,
            peakHour: peakHour >= 0 ? peakHour : null,
        },
        topSymbols,
        timeframes: tfTop,
        indicators: countTop(indicators, 10).map((r) => ({ ...r, label: indicatorLabel(r.key) })),
        styles: countTop(styles, 6),
        layouts: countTop(layouts, 5),
        classMix: countTop(classMix, 8),
        sectors: countTop(sectorMix, 8),
        themes: opts.related.themes(interest, 12),
        heatmap: heat.map((row) => row.map((v) => Math.round(v * 10) / 10)),
        last30,
        badges: badges({ tfUse, classMix, sectorMix, peakHour, totalOpens, distinct: opens.size, longest, indicators }),
        suggestions,
        because,
    };
}

function share(map: Map<string, number>, keys: string[]): number {
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    return keys.reduce((a, k) => a + (map.get(k) ?? 0), 0) / total;
}

function badges(s: {
    tfUse: Map<string, number>;
    classMix: Map<string, number>;
    sectorMix: Map<string, number>;
    peakHour: number;
    totalOpens: number;
    distinct: number;
    longest: number;
    indicators: Map<string, number>;
}): Badge[] {
    const out: Badge[] = [];
    if (s.totalOpens === 0) return [{ id: 'newcomer', title: 'Fresh start', detail: 'Open a few charts and your profile builds itself.' }];
    // Trading style from the time-weighted median timeframe.
    const tfs = [...s.tfUse.entries()].map(([tf, w]) => [tfMinutes(tf), w] as const).sort((a, b) => a[0] - b[0]);
    const half = tfs.reduce((a, [, w]) => a + w, 0) / 2;
    let acc = 0;
    let median = 1440;
    for (const [m, w] of tfs) {
        acc += w;
        if (acc >= half) {
            median = m;
            break;
        }
    }
    if (median <= 5) out.push({ id: 'scalper', title: 'Scalper', detail: 'You live on the 1–5 minute charts.' });
    else if (median <= 60) out.push({ id: 'daytrader', title: 'Day trader', detail: 'Intraday timeframes are your home turf.' });
    else if (median < 1440) out.push({ id: 'swing', title: 'Swing trader', detail: 'Hours-long candles, days-long ideas.' });
    else out.push({ id: 'investor', title: 'Position investor', detail: 'Daily and weekly charts — the long view.' });

    if (share(s.classMix, ['crypto']) > 0.4) out.push({ id: 'crypto', title: 'Crypto native', detail: 'Coins take a big share of your screen time.' });
    if (share(s.sectorMix, ['Energy', 'Commodities', 'Utilities']) > 0.3) out.push({ id: 'energy', title: 'Energy hawk', detail: 'Oil, gas and power prices are on your radar.' });
    if (share(s.classMix, ['index', 'forex']) > 0.3) out.push({ id: 'macro', title: 'Macro mind', detail: 'Indices, the dollar and FX shape your view.' });
    if (share(s.sectorMix, ['Technology', 'Communication']) > 0.5) out.push({ id: 'tech', title: 'Tech bull', detail: 'Most of your attention goes to tech.' });
    if (s.peakHour >= 22 || (s.peakHour >= 0 && s.peakHour < 5)) out.push({ id: 'nightowl', title: 'Night owl', detail: 'Your busiest hour is after dark.' });
    else if (s.peakHour >= 5 && s.peakHour < 9) out.push({ id: 'earlybird', title: 'Early bird', detail: 'You check the market before most people wake.' });
    if (s.distinct >= 40) out.push({ id: 'explorer', title: 'Explorer', detail: `${s.distinct} different symbols opened.` });
    if (s.longest >= 7) out.push({ id: 'streak', title: 'On a roll', detail: `${s.longest} days in a row.` });
    if ([...s.indicators.values()].reduce((a, b) => a + b, 0) >= 15) out.push({ id: 'tinkerer', title: 'Indicator tinkerer', detail: 'You like to stack studies.' });
    return out;
}
