// What the cache warmer prefetches: for every active account, the charts in its saved
// layout and its watchlist at the timeframes it actually uses. The server reads two
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

export interface WarmPlan {
    targets: WarmTarget[];
    /** Every watched symbol (canonical) with how many accounts watch it. */
    watched: Map<string, number>;
}

const DEFAULT_LIMIT = 1_000;
const USAGE_WINDOW_MS = 30 * 86_400_000;
const TOP_TIMEFRAMES = 2;

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

/** The account's most used timeframes over the last month, from its activity log. */
function topTimeframes(db: Db, userId: number, now: number): string[] {
    const rows = db.prepare("SELECT kind, value, extra, n FROM analytics_events WHERE user_id = ? AND ts >= ? AND kind IN ('tf', 'open', 'watch')").all(userId, now - USAGE_WINDOW_MS) as Array<{
        kind: string;
        value: string;
        extra: string | null;
        n: number;
    }>;
    const use = new Map<string, number>();
    const add = (tf: string | null, w: number) => {
        if (tf) use.set(tf, (use.get(tf) ?? 0) + w);
    };
    for (const r of rows) {
        if (r.kind === 'tf') add(r.value, 1);
        else if (r.kind === 'open') add(r.extra, 1);
        else add(r.extra, 0.2 * r.n);
    }
    return [...use.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TIMEFRAMES)
        .map(([tf]) => tf);
}

export function collectTargets(db: Db, catalog: Catalog, now = Date.now()): WarmPlan {
    const users = db.prepare('SELECT id FROM users WHERE disabled = 0').all() as Array<{ id: number }>;
    const storage = db.prepare("SELECT key, value FROM user_storage WHERE user_id = ? AND key IN ('watchlist', 'workspace')");
    const defaults = catalog.defaultGroups().flatMap((g) => g.symbols);
    const byKey = new Map<string, WarmTarget>();
    const watched = new Map<string, number>();

    for (const u of users) {
        const docs = new Map((storage.all(u.id) as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
        const charts = parseWorkspaceCharts(docs.get('workspace')) ?? [{ symbol: 'SPY', tf: 'D', session: undefined, limit: DEFAULT_LIMIT }];
        const list = parseWatchlistSymbols(docs.get('watchlist')) ?? defaults;
        const tfs = [...new Set([...charts.map((c) => c.tf), ...topTimeframes(db, u.id, now), 'D'])];
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
            for (const tf of tfs) add({ symbol: entry.symbol, tf, session: extended ? 'extended' : undefined, limit: DEFAULT_LIMIT }, false);
        }
        for (const s of symbols) watched.set(s, (watched.get(s) ?? 0) + 1);
    }
    const targets = [...byKey.values()].sort((a, b) => Number(b.layout) - Number(a.layout) || b.accounts - a.accounts || a.symbol.localeCompare(b.symbol));
    return { targets, watched };
}
