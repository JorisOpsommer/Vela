// What the cache warmer prefetches: for every account active in the last two weeks, the
// charts in its saved layout, its watchlist at 4h and Daily, and the symbols it spent the
// most time on at 15m and 1h. The server reads two
// documents the browser owns (the `watchlist` and `workspace` storage keys) — their
// shapes are parsed defensively here, in one place, so a format change breaks only this.
import type { Db } from '../db';
import { bareSymbol, type Catalog } from './catalog';
import { MAX_BARS_PER_SERIES, seriesKey } from './cache-store';

export interface WarmTarget {
    symbol: string;
    tf: string;
    /** `regular` | `extended` for US equities, `all` elsewhere. */
    session: string;
    limit: number;
    /** Accounts that would open this chart. */
    accounts: number;
    /** In a saved layout: the chart that account boots into. */
    layout: boolean;
}

export interface AccountPlan {
    userId: number;
    /** Canonical watchlist symbols, warmed at {@link WARM_TIMEFRAMES}. */
    watchlist: string[];
    /** Its most active symbols, warmed at {@link INTRADAY_TIMEFRAMES}. */
    top: Array<{ symbol: string; minutes: number; opens: number }>;
}

export interface WarmPlan {
    targets: WarmTarget[];
    /** Every watched symbol (canonical) with how many accounts watch it. */
    watched: Map<string, number>;
    accounts: AccountPlan[];
}

const DEFAULT_LIMIT = 1_000;
export const ACTIVE_WINDOW_MS = 14 * 86_400_000;
/** Every watched symbol is warmed at these. */
export const WARM_TIMEFRAMES = ['240', 'D'];
/** An account's most active symbols are also warmed at these. */
export const INTRADAY_TIMEFRAMES = ['15', '60'];
export const TOP_SYMBOLS = 10;

interface ChartRef {
    symbol: string;
    tf: string;
    session: string | undefined;
    limit: number;
}

export function parseWatchlistSymbols(raw: string | undefined): string[] | null {
    if (!raw) return null;
    try {
        const d = JSON.parse(raw) as { version?: unknown; groups?: unknown };
        if (d?.version !== 1 || !Array.isArray(d.groups)) return null;
        return d.groups.flatMap((g: { symbols?: unknown }) => (Array.isArray(g?.symbols) ? g.symbols.filter((s): s is string => typeof s === 'string').map(bareSymbol) : []));
    } catch {
        return null;
    }
}

export function parseWorkspaceCharts(raw: string | undefined): ChartRef[] | null {
    if (!raw) return null;
    try {
        const d = JSON.parse(raw) as { charts?: unknown };
        if (!Array.isArray(d?.charts)) return null;
        const out: ChartRef[] = [];
        for (const c of d.charts as Array<Record<string, unknown>>) {
            if (typeof c?.symbol !== 'string' || typeof c.timeframe !== 'string') continue;
            out.push({
                symbol: bareSymbol(c.symbol),
                tf: c.timeframe,
                session: typeof c.session === 'string' ? c.session : undefined,
                limit: typeof c.bars === 'number' && c.bars > 0 ? Math.min(Math.floor(c.bars), MAX_BARS_PER_SERIES) : DEFAULT_LIMIT,
            });
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * The account's most active symbols of the window: the most minutes on screen, then the
 * most opens. Event values are bare symbols; ones the catalog no longer knows are dropped.
 */
function topSymbols(db: Db, catalog: Catalog, userId: number, since: number): AccountPlan['top'] {
    const rows = db
        .prepare(
            `SELECT value, SUM(CASE WHEN kind = 'watch' THEN n ELSE 0 END) AS minutes, SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens
             FROM analytics_events WHERE user_id = ? AND ts >= ? AND kind IN ('watch', 'open')
             GROUP BY value ORDER BY minutes DESC, opens DESC LIMIT ?`,
        )
        .all(userId, since, TOP_SYMBOLS * 3) as Array<{ value: string; minutes: number; opens: number }>;
    const out = new Map<string, AccountPlan['top'][number]>();
    for (const r of rows) {
        const entry = catalog.resolve(r.value);
        if (!entry) continue;
        const prev = out.get(entry.symbol);
        if (prev) {
            prev.minutes += r.minutes;
            prev.opens += r.opens;
        } else out.set(entry.symbol, { symbol: entry.symbol, minutes: r.minutes, opens: r.opens });
    }
    return [...out.values()].sort((a, b) => b.minutes - a.minutes || b.opens - a.opens).slice(0, TOP_SYMBOLS);
}

export function collectTargets(db: Db, catalog: Catalog, now = Date.now()): WarmPlan {
    // Active: signed in, charting or changing a document recently. Sessions are deleted on
    // sign-out and expiry, so the other two keep an account active through those.
    const users = db
        .prepare(
            `SELECT id FROM users u WHERE disabled = 0 AND MAX(
                COALESCE((SELECT MAX(last_seen) FROM sessions WHERE user_id = u.id), 0),
                COALESCE((SELECT MAX(ts) FROM analytics_events WHERE user_id = u.id), 0),
                COALESCE((SELECT MAX(updated_at) FROM user_storage WHERE user_id = u.id), 0)
            ) >= ?`,
        )
        .all(now - ACTIVE_WINDOW_MS) as Array<{ id: number }>;
    const storage = db.prepare("SELECT key, value FROM user_storage WHERE user_id = ? AND key IN ('watchlist', 'workspace')");
    const defaults = catalog.defaultGroups().flatMap((g) => g.symbols);
    const byKey = new Map<string, WarmTarget>();
    const watched = new Map<string, number>();
    const accounts: AccountPlan[] = [];

    for (const u of users) {
        const docs = new Map((storage.all(u.id) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
        const charts = parseWorkspaceCharts(docs.get('workspace')) ?? [{ symbol: 'SPY', tf: 'D', session: undefined, limit: DEFAULT_LIMIT }];
        const list = parseWatchlistSymbols(docs.get('watchlist')) ?? defaults;
        const extended = charts.some((c) => c.session === 'extended');
        const seen = new Set<string>();
        const add = (ref: ChartRef, layout: boolean) => {
            const entry = catalog.resolve(ref.symbol);
            if (!entry) return;
            const session = entry.class === 'stock' || entry.class === 'etf' ? (ref.session === 'extended' ? 'extended' : 'regular') : 'all';
            const key = seriesKey(entry.symbol, ref.tf, session);
            const t = byKey.get(key);
            const first = !seen.has(key);
            seen.add(key);
            if (!t) byKey.set(key, { symbol: entry.symbol, tf: ref.tf, session, limit: ref.limit, accounts: 1, layout });
            else {
                t.limit = Math.max(t.limit, ref.limit);
                t.layout ||= layout;
                if (first) t.accounts += 1;
            }
        };
        for (const c of charts) add(c, true);
        const symbols = new Set<string>();
        for (const s of list) {
            const entry = catalog.resolve(s);
            if (!entry) continue;
            symbols.add(entry.symbol);
            for (const tf of WARM_TIMEFRAMES) add({ symbol: entry.symbol, tf, session: extended ? 'extended' : undefined, limit: DEFAULT_LIMIT }, false);
        }
        const top = topSymbols(db, catalog, u.id, now - ACTIVE_WINDOW_MS);
        for (const t of top) for (const tf of INTRADAY_TIMEFRAMES) add({ symbol: t.symbol, tf, session: extended ? 'extended' : undefined, limit: DEFAULT_LIMIT }, false);
        for (const s of symbols) watched.set(s, (watched.get(s) ?? 0) + 1);
        accounts.push({ userId: u.id, watchlist: [...symbols], top });
    }
    const targets = [...byKey.values()].sort((a, b) => Number(b.layout) - Number(a.layout) || b.accounts - a.accounts || a.symbol.localeCompare(b.symbol));
    return { targets, watched, accounts };
}
