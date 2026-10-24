// The active userbase: which accounts the background jobs serve, and what they watch.
import { describe, expect, it } from 'vitest';
import { openDbAt } from '../server/db';
import { Catalog } from '../server/market/catalog';
import { ACTIVE_WINDOW_MS, activeUserbase, parseWatchlistSymbols, watchedSymbols } from '../server/analytics/userbase';

const NOW = Date.UTC(2026, 9, 21, 15, 0);
const DAY = 86_400_000;

function world() {
    const catalog = new Catalog(
        {
            groups: [{ name: 'Default', symbols: ['IDX'] }],
            instruments: {
                IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                ALT: { name: 'Alt', class: 'index', prefix: 'INDEX', yahoo: 'ALT', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
            },
        },
        { alpaca: false, finnhub: false },
    );
    const db = openDbAt(':memory:');
    const addUser = (name: string, disabled = 0) =>
        Number(db.prepare("INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at) VALUES (?, 'x', 'user', ?, 0, 0)").run(name, disabled).lastInsertRowid);
    const save = (userId: number, key: string, value: unknown, at: number) =>
        db.prepare('INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)').run(userId, key, JSON.stringify(value), at);
    return { db, catalog, addUser, save };
}

describe('activeUserbase', () => {
    it('keeps accounts used within the window, by session, event or saved document', () => {
        const { db, catalog, addUser, save } = world();
        const bySession = addUser('session');
        db.prepare("INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, last_seen) VALUES ('h', ?, 'c', 0, ?, ?)").run(bySession, NOW + DAY, NOW - DAY);
        const byEvent = addUser('event');
        db.prepare("INSERT INTO analytics_events (user_id, ts, kind, value) VALUES (?, ?, 'open', 'IDX')").run(byEvent, NOW - 2 * DAY);
        const byDoc = addUser('doc');
        save(byDoc, 'watchlist', { version: 1, groups: [{ name: 'A', symbols: ['ALT'] }] }, NOW - 3 * DAY);
        const stale = addUser('stale');
        save(stale, 'watchlist', { version: 1, groups: [] }, NOW - ACTIVE_WINDOW_MS - DAY);
        const disabled = addUser('disabled', 1);
        save(disabled, 'watchlist', { version: 1, groups: [] }, NOW);

        const accounts = activeUserbase(db, catalog, NOW);
        expect(accounts.map((a) => a.userId)).toEqual([bySession, byEvent, byDoc]);
        expect(accounts.find((a) => a.userId === byDoc)?.lastActive).toBe(NOW - 3 * DAY);
    });

    it('reads the saved watchlist in canonical form, falling back to the default groups', () => {
        const { db, catalog, addUser, save } = world();
        const saved = addUser('saved');
        save(saved, 'watchlist', { version: 1, groups: [{ name: 'A', symbols: ['INDEX:ALT', 'alt'] }] }, NOW);
        const fresh = addUser('fresh');
        save(fresh, 'workspace', { version: 1, charts: [] }, NOW);

        const accounts = activeUserbase(db, catalog, NOW);
        expect(accounts.map((a) => a.watchlist)).toEqual([['ALT'], ['IDX']]);
        expect(accounts[1]!.docs.workspace).toBeDefined();
        expect([...watchedSymbols(accounts)]).toEqual([['ALT', 1], ['IDX', 1]]);
    });

    it('treats a watchlist document it cannot read as absent', () => {
        expect(parseWatchlistSymbols('{')).toBeNull();
        expect(parseWatchlistSymbols(JSON.stringify({ version: 2, groups: [] }))).toBeNull();
        expect(parseWatchlistSymbols(JSON.stringify({ version: 1, groups: [{ symbols: ['nasdaq:aapl', 3] }] }))).toEqual(['AAPL']);
    });
});
