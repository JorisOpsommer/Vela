// The market-data cache on disk: bars and quotes the server already fetched, kept so a
// chart or a watchlist can paint from them before the providers answer. Its own SQLite
// file beside the accounts database — deleting it loses nothing but speed.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { OHLCV } from './types';

/** Newest bars kept per series; older ones are trimmed on write. */
export const MAX_BARS_PER_SERIES = 2_000;
/** A series or quote nobody read or refreshed for this long is purged. */
export const RETENTION_MS = 5 * 86_400_000;
/** Overlapping closes that differ by more than this mean the history was rewritten (a split). */
const MISMATCH_RATIO = 0.005;
const TIMINGS_KEEP_MS = 7 * 86_400_000;
/** Newest timings kept at most — the browser reports them, so their count is not ours to trust. */
const TIMINGS_KEEP = 50_000;
const EVENTS_KEEP = 500;
const RUNS_KEEP = 200;

export interface SeriesMeta {
    symbol: string;
    tf: string;
    session: string;
    source: string;
}

export interface SeriesRow extends SeriesMeta {
    key: string;
    /** Oldest bar of the stored stretch: from here to {@link settledTo} nothing is missing. */
    coveredFrom: number;
    /** Bars that open before this are final; later ones were still forming when fetched. */
    settledTo: number;
    /** The deepest initial load (bar count) this series has fully answered. */
    depth: number;
    fetchedAt: number;
    readAt: number;
    bars: number;
}

export interface WriteOptions {
    /** Coverage of this answer: from its first bar up to here nothing is missing. */
    coverTo: number;
    /** Bars opening before this are final. */
    settledTo: number;
    /** The answer reaches the present: stored bars after its last one are stale leftovers. */
    reachesNow: boolean;
    /** Bar count of an initial load this answer fully served. */
    depth?: number;
}

export interface CacheEvent {
    at: number;
    kind: string;
    detail: string;
}

export interface WarmRunRow {
    id: number;
    kind: string;
    slot: number;
    startedAt: number;
    endedAt: number | null;
    total: number;
    done: number;
    skipped: number;
    failed: number;
    calls: number;
    status: string;
}

export function seriesKey(symbol: string, tf: string, session: string): string {
    return `${symbol}|${tf}|${session}`;
}

type Row = Record<string, number | string | null>;

export class CacheStore {
    private readonly db: DatabaseSync;

    constructor(readonly file: string, private readonly now: () => number = Date.now) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        // Incremental vacuum only takes effect when set before the first table exists.
        this.db.exec('PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS series (
                key TEXT PRIMARY KEY, symbol TEXT NOT NULL, tf TEXT NOT NULL, session TEXT NOT NULL, source TEXT NOT NULL,
                covered_from INTEGER NOT NULL, settled_to INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
                fetched_at INTEGER NOT NULL, read_at INTEGER NOT NULL, bars INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS bars (
                key TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
                PRIMARY KEY (key, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS quotes (symbol TEXT PRIMARY KEY, row TEXT NOT NULL, fetched_at INTEGER NOT NULL, read_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS timings (at INTEGER NOT NULL, kind TEXT NOT NULL, ms REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS timings_at ON timings(at);
            CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS warm_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, slot INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
                total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                calls INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
            );
        `);
    }

    close(): void {
        this.db.close();
    }

    private tx<T>(fn: () => T): T {
        this.db.exec('BEGIN');
        try {
            const v = fn();
            this.db.exec('COMMIT');
            return v;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    // ── Bars ───────────────────────────────────────────────────────────────

    series(key: string): SeriesRow | undefined {
        const r = this.db.prepare('SELECT * FROM series WHERE key = ?').get(key) as Row | undefined;
        return r ? toSeries(r) : undefined;
    }

    allSeries(): SeriesRow[] {
        return (this.db.prepare('SELECT * FROM series ORDER BY symbol, tf, session').all() as Row[]).map(toSeries);
    }

    /** Stored bars in `[from, to]`, at most the newest `limit` — `clip` semantics. */
    bars(key: string, range: { from?: number; to?: number; limit?: number } = {}): OHLCV[] {
        const rows = this.db
            .prepare('SELECT time, open, high, low, close, volume FROM bars WHERE key = ? AND time >= ? AND time <= ? ORDER BY time DESC LIMIT ?')
            .all(key, range.from ?? Number.MIN_SAFE_INTEGER, range.to ?? Number.MAX_SAFE_INTEGER, range.limit ?? -1) as Array<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }>;
        rows.reverse();
        return rows.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, ...(r.volume != null ? { volume: r.volume } : {}) }));
    }

    /** Stored bars in `[from, to]`. */
    count(key: string, from: number, to: number): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM bars WHERE key = ? AND time >= ? AND time <= ?').get(key, from, to) as { n: number }).n;
    }

    touch(key: string): void {
        this.db.prepare('UPDATE series SET read_at = ? WHERE key = ?').run(this.now(), key);
    }

    /**
     * Store one upstream answer. Overlapping final bars must agree with what is stored;
     * when they do not (a split rewrote the history) the series restarts from this answer.
     * An answer that does not touch the stored stretch, or comes from another source,
     * restarts it only when it is a full initial load (`depth`); anything smaller is dropped.
     * Returns whether stored history was thrown away for disagreeing.
     */
    write(meta: SeriesMeta, bars: readonly OHLCV[], w: WriteOptions): { replaced: boolean } {
        if (bars.length === 0) return { replaced: false };
        const key = seriesKey(meta.symbol, meta.tf, meta.session);
        const first = bars[0]!.time;
        const last = bars[bars.length - 1]!.time;
        const t = this.now();
        return this.tx(() => {
            const existing = this.series(key);
            let replaced = false;
            let contiguous = false;
            if (existing) {
                // The stored stretch runs to its newest bar (forming ones included): an answer
                // starting at or before it overlaps.
                const newest = (this.db.prepare('SELECT MAX(time) AS t FROM bars WHERE key = ?').get(key) as { t: number | null }).t ?? existing.settledTo;
                contiguous = first <= Math.max(existing.settledTo, newest) && w.coverTo >= existing.coveredFrom;
                // Only a full initial load may restart the series: a short answer that does not
                // touch it, or that a fallback source served, must not wipe a deeper history.
                if ((!contiguous || existing.source !== meta.source) && w.depth == null) return { replaced: false };
                if (contiguous) {
                    const finalTo = Math.min(existing.settledTo, w.settledTo) - 1;
                    const stored = new Map(this.bars(key, { from: first, to: finalTo }).map((b) => [b.time, b.close]));
                    for (const b of bars) {
                        if (b.time > finalTo) break;
                        const c = stored.get(b.time);
                        if (c != null && Math.abs(c - b.close) > MISMATCH_RATIO * Math.max(Math.abs(b.close), 1e-9)) {
                            replaced = true;
                            break;
                        }
                    }
                }
                if (replaced || !contiguous || existing.source !== meta.source) {
                    this.db.prepare('DELETE FROM bars WHERE key = ?').run(key);
                    contiguous = false;
                }
            }
            const ins = this.db.prepare('INSERT INTO bars (key, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key, time) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume');
            for (const b of bars) ins.run(key, b.time, b.open, b.high, b.low, b.close, b.volume ?? null);
            if (w.reachesNow) this.db.prepare('DELETE FROM bars WHERE key = ? AND time > ?').run(key, last);

            let coveredFrom = contiguous ? Math.min(existing!.coveredFrom, first) : first;
            const count = (this.db.prepare('SELECT COUNT(*) AS n FROM bars WHERE key = ?').get(key) as { n: number }).n;
            let kept = count;
            if (count > MAX_BARS_PER_SERIES) {
                const cut = this.db.prepare('SELECT time FROM bars WHERE key = ? ORDER BY time DESC LIMIT 1 OFFSET ?').get(key, MAX_BARS_PER_SERIES - 1) as { time: number };
                this.db.prepare('DELETE FROM bars WHERE key = ? AND time < ?').run(key, cut.time);
                coveredFrom = cut.time;
                kept = MAX_BARS_PER_SERIES;
            }
            const settledTo = contiguous ? Math.max(existing!.settledTo, w.settledTo) : w.settledTo;
            const depth = Math.min(Math.max(contiguous ? existing!.depth : 0, w.depth ?? 0), kept);
            const fetchedAt = w.reachesNow || !existing || !contiguous ? t : existing.fetchedAt;
            this.db
                .prepare(
                    `INSERT INTO series (key, symbol, tf, session, source, covered_from, settled_to, depth, fetched_at, read_at, bars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET source = excluded.source, covered_from = excluded.covered_from, settled_to = excluded.settled_to, depth = excluded.depth, fetched_at = excluded.fetched_at, bars = excluded.bars`,
                )
                .run(key, meta.symbol, meta.tf, meta.session, meta.source, coveredFrom, settledTo, depth, fetchedAt, existing?.readAt ?? t, kept);
            if (replaced) this.logEvent('replaced', `${meta.symbol} ${meta.tf} ${meta.session}: stored history disagreed with the provider and was refetched`);
            return { replaced };
        });
    }

    // ── Quotes ─────────────────────────────────────────────────────────────

    putQuotes(rows: ReadonlyArray<{ symbol: string }>): void {
        if (rows.length === 0) return;
        const t = this.now();
        const ins = this.db.prepare('INSERT INTO quotes (symbol, row, fetched_at, read_at) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET row = excluded.row, fetched_at = excluded.fetched_at');
        this.tx(() => {
            for (const r of rows) ins.run(r.symbol, JSON.stringify(r), t, t);
        });
    }

    quotes(symbols: readonly string[]): Array<{ row: unknown; fetchedAt: number }> {
        if (symbols.length === 0) return [];
        const t = this.now();
        const get = this.db.prepare('SELECT row, fetched_at FROM quotes WHERE symbol = ?');
        const touch = this.db.prepare('UPDATE quotes SET read_at = ? WHERE symbol = ?');
        const out: Array<{ row: unknown; fetchedAt: number }> = [];
        for (const s of symbols) {
            const r = get.get(s) as { row: string; fetched_at: number } | undefined;
            if (!r) continue;
            touch.run(t, s);
            out.push({ row: JSON.parse(r.row), fetchedAt: r.fetched_at });
        }
        return out;
    }

    quoteAges(): Array<{ symbol: string; fetchedAt: number }> {
        return (this.db.prepare('SELECT symbol, fetched_at FROM quotes ORDER BY symbol').all() as Array<{ symbol: string; fetched_at: number }>).map((r) => ({ symbol: r.symbol, fetchedAt: r.fetched_at }));
    }

    // ── Timings, events, warm runs ─────────────────────────────────────────

    recordTiming(kind: string, ms: number): void {
        const r = this.db.prepare('INSERT INTO timings (at, kind, ms) VALUES (?, ?, ?)').run(this.now(), kind, ms);
        if (Number(r.lastInsertRowid) % 1_000 === 0) this.db.prepare('DELETE FROM timings WHERE rowid <= (SELECT rowid FROM timings ORDER BY rowid DESC LIMIT 1 OFFSET ?)').run(TIMINGS_KEEP);
    }

    timings(since: number): Array<{ at: number; kind: string; ms: number }> {
        return this.db.prepare('SELECT at, kind, ms FROM timings WHERE at >= ? ORDER BY at').all(since) as Array<{ at: number; kind: string; ms: number }>;
    }

    logEvent(kind: string, detail: string): void {
        this.db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(this.now(), kind, detail.slice(0, 300));
    }

    events(limit = 50): CacheEvent[] {
        return this.db.prepare('SELECT at, kind, detail FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as CacheEvent[];
    }

    startRun(kind: string, slot: number, total: number): number {
        const r = this.db.prepare("INSERT INTO warm_runs (kind, slot, started_at, total, status) VALUES (?, ?, ?, ?, 'running')").run(kind, slot, this.now(), total);
        return Number(r.lastInsertRowid);
    }

    updateRun(id: number, p: { done: number; skipped: number; failed: number; calls: number; status?: string; ended?: boolean }): void {
        this.db
            .prepare('UPDATE warm_runs SET done = ?, skipped = ?, failed = ?, calls = ?, status = COALESCE(?, status), ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?')
            .run(p.done, p.skipped, p.failed, p.calls, p.status ?? null, p.ended ? 1 : 0, this.now(), id);
    }

    /** The newest finished-or-running run of `kind`, for the schedule. */
    lastRun(kind: string): WarmRunRow | undefined {
        const r = this.db.prepare('SELECT * FROM warm_runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as Row | undefined;
        return r ? toRun(r) : undefined;
    }

    runs(limit = 20): WarmRunRow[] {
        return (this.db.prepare('SELECT * FROM warm_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toRun);
    }

    /** Runs a previous process left marked running: they did not finish. */
    abandonRunning(): void {
        this.db.prepare("UPDATE warm_runs SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at) WHERE status IN ('running', 'paused')").run();
    }

    // ── Housekeeping ───────────────────────────────────────────────────────

    /** Drop what nobody read or refreshed within the retention window; reclaim the space. */
    purge(retentionMs = RETENTION_MS): { series: number; bars: number; quotes: number } {
        const cutoff = this.now() - retentionMs;
        const out = this.tx(() => {
            const stale = (this.db.prepare('SELECT key FROM series WHERE MAX(read_at, fetched_at) < ?').all(cutoff) as Array<{ key: string }>).map((r) => r.key);
            let bars = 0;
            for (const key of stale) {
                bars += Number(this.db.prepare('DELETE FROM bars WHERE key = ?').run(key).changes);
                this.db.prepare('DELETE FROM series WHERE key = ?').run(key);
            }
            const quotes = Number(this.db.prepare('DELETE FROM quotes WHERE MAX(read_at, fetched_at) < ?').run(cutoff).changes);
            this.db.prepare('DELETE FROM timings WHERE at < ?').run(this.now() - TIMINGS_KEEP_MS);
            this.db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(EVENTS_KEEP);
            this.db.prepare('DELETE FROM warm_runs WHERE id <= (SELECT id FROM warm_runs ORDER BY id DESC LIMIT 1 OFFSET ?)').run(RUNS_KEEP);
            return { series: stale.length, bars, quotes };
        });
        this.db.exec('PRAGMA incremental_vacuum');
        if (out.series + out.quotes > 0) this.logEvent('purge', `removed ${out.series} series (${out.bars} bars) and ${out.quotes} quotes unused for ${Math.round(retentionMs / 86_400_000)} days`);
        return out;
    }

    /** Empty every market-data table (the logs stay, so the clear itself is on record). */
    clear(): void {
        this.tx(() => {
            this.db.exec('DELETE FROM bars; DELETE FROM series; DELETE FROM quotes;');
        });
        this.db.exec('PRAGMA incremental_vacuum');
        this.logEvent('clear', 'the whole market-data cache was cleared');
    }

    sizeBytes(): number {
        const pages = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
        const free = (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
        const size = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
        return (pages - free) * size;
    }

    totals(): { series: number; bars: number; symbols: number; quotes: number; oldestFetch: number | null; newestFetch: number | null } {
        const s = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bars), 0) AS b, COUNT(DISTINCT symbol) AS sym, MIN(fetched_at) AS lo, MAX(fetched_at) AS hi FROM series').get() as { n: number; b: number; sym: number; lo: number | null; hi: number | null };
        const q = this.db.prepare('SELECT COUNT(*) AS n FROM quotes').get() as { n: number };
        return { series: s.n, bars: s.b, symbols: s.sym, quotes: q.n, oldestFetch: s.lo, newestFetch: s.hi };
    }
}

function toSeries(r: Row): SeriesRow {
    return {
        key: String(r.key),
        symbol: String(r.symbol),
        tf: String(r.tf),
        session: String(r.session),
        source: String(r.source),
        coveredFrom: Number(r.covered_from),
        settledTo: Number(r.settled_to),
        depth: Number(r.depth),
        fetchedAt: Number(r.fetched_at),
        readAt: Number(r.read_at),
        bars: Number(r.bars),
    };
}

function toRun(r: Row): WarmRunRow {
    return {
        id: Number(r.id),
        kind: String(r.kind),
        slot: Number(r.slot),
        startedAt: Number(r.started_at),
        endedAt: r.ended_at == null ? null : Number(r.ended_at),
        total: Number(r.total),
        done: Number(r.done),
        skipped: Number(r.skipped),
        failed: Number(r.failed),
        calls: Number(r.calls),
        status: String(r.status),
    };
}
