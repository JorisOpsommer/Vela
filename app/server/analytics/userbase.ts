// The active userbase: the accounts every background job serves (the cache warmer, the
// daily options snapshot, trend detection). One definition of "active" so the jobs agree
// on whom they work for. The watchlist is a document the browser owns — its shape is
// parsed defensively here, in one place, so a format change breaks only this.
import type { Db } from '../db';
import { bareSymbol, type Catalog } from '../market/catalog';

/** An account counts as active when it was used within this window. */
export const ACTIVE_WINDOW_MS = 14 * 86_400_000;

export interface ActiveAccount {
    userId: number;
    /** Newest of: session use, a charting event, a saved document. */
    lastActive: number;
    /** The account's saved documents the jobs read, raw (absent = never saved). */
    docs: { watchlist?: string; workspace?: string };
    /** Canonical watchlist symbols the catalog knows, in list order — the default
     *  groups for an account that never saved a watchlist. */
    watchlist: string[];
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

/**
 * Every enabled account used within `windowMs`: signed in, charting or changing a document.
 * Sessions are deleted on sign-out and expiry, so the other two keep an account active
 * through those.
 */
export function activeUserbase(db: Db, catalog: Catalog, now = Date.now(), windowMs = ACTIVE_WINDOW_MS): ActiveAccount[] {
    const users = db
        .prepare(
            `SELECT id, MAX(
                COALESCE((SELECT MAX(last_seen) FROM sessions WHERE user_id = u.id), 0),
                COALESCE((SELECT MAX(ts) FROM analytics_events WHERE user_id = u.id), 0),
                COALESCE((SELECT MAX(updated_at) FROM user_storage WHERE user_id = u.id), 0)
            ) AS last_active FROM users u WHERE disabled = 0 AND last_active >= ? ORDER BY id`,
        )
        .all(now - windowMs) as Array<{ id: number; last_active: number }>;
    const storage = db.prepare("SELECT key, value FROM user_storage WHERE user_id = ? AND key IN ('watchlist', 'workspace')");
    return users.map((u) => {
        const rows = storage.all(u.id) as Array<{ key: string; value: string }>;
        const docs: ActiveAccount['docs'] = {};
        for (const r of rows) docs[r.key as keyof ActiveAccount['docs']] = r.value;
        return { userId: u.id, lastActive: u.last_active, docs, watchlist: canonicalWatchlist(docs.watchlist, catalog) };
    });
}

/** Every symbol the accounts watch (canonical), with how many accounts watch it. */
export function watchedSymbols(accounts: readonly ActiveAccount[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of accounts) for (const s of a.watchlist) out.set(s, (out.get(s) ?? 0) + 1);
    return out;
}

/** A saved watchlist's symbols the catalog knows, canonical and in list order — the
 *  default groups for an account that never saved one. */
function canonicalWatchlist(raw: string | undefined, catalog: Catalog): string[] {
    const symbols = new Set<string>();
    for (const s of parseWatchlistSymbols(raw) ?? catalog.defaultGroups().flatMap((g) => g.symbols)) {
        const entry = catalog.resolve(s);
        if (entry) symbols.add(entry.symbol);
    }
    return [...symbols];
}

/** One account's watchlist, whether or not the account counts as active. */
export function accountWatchlist(db: Db, catalog: Catalog, userId: number): string[] {
    const row = db.prepare("SELECT value FROM user_storage WHERE user_id = ? AND key = 'watchlist'").get(userId) as { value: string } | undefined;
    return canonicalWatchlist(row?.value, catalog);
}
