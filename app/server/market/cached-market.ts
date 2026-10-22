// The market router with a memory: chart loads are answered from the on-disk cache where
// it provably holds the bars, topped up with only the newest stretch from the providers,
// and every upstream answer is written back. A cache failure never fails a request — it
// only costs the speed-up.
import type { BarRequest, BridgeId, CatalogEntry, OHLCV } from './types';
import type { MarketService, QuoteRow } from './service';
import { CacheStore, seriesKey, type SeriesRow } from './cache-store';
import { nominalMs, parseTimeframe, type Timeframe } from './timeframes';

/** Smaller loads (live-tail polls) gain nothing from the cache and are passed through. */
const MIN_CACHED_LIMIT = 50;
/** US equity history arrives from the consolidated tape up to 15 minutes late. */
const EQUITY_SETTLE_MS = 20 * 60_000;
const SETTLE_MS = 2 * 60_000;
/** A stored series not filled by a chart load must hold at least this many bars to be painted. */
const PEEK_MIN_BARS = 100;
/** How long a cache read may wait on the exchange calendar before answering without it. */
const CALENDAR_WAIT_MS = 150;

export type CacheOutcome = 'complete' | 'merged' | 'range' | 'fetched' | 'passthrough';

export interface CachedBars {
    entry: CatalogEntry;
    source: BridgeId;
    bars: OHLCV[];
    cache: CacheOutcome;
}

export interface PeekedBars {
    bars: OHLCV[];
    /** When the newest stored bar was fetched. */
    asOf: number;
    /** Nothing newer can exist yet: the session closed after this was fetched. */
    complete: boolean;
    source: string;
}

interface SourceCounters {
    avoided: number;
    tailOnly: number;
    full: number;
    barsFromCache: number;
    barsFromUpstream: number;
}

export class CachedMarket {
    readonly counters = {
        complete: 0,
        merged: 0,
        range: 0,
        fetched: 0,
        passthrough: 0,
        replaced: 0,
        peekHit: 0,
        peekMiss: 0,
        quotePeekHit: 0,
        quotePeekMiss: 0,
        storeErrors: 0,
    };
    readonly bySource = new Map<string, SourceCounters>();

    constructor(readonly market: MarketService, readonly store: CacheStore, private readonly now: () => number = Date.now) {}

    private source(id: string): SourceCounters {
        let c = this.bySource.get(id);
        if (!c) {
            c = { avoided: 0, tailOnly: 0, full: 0, barsFromCache: 0, barsFromUpstream: 0 };
            this.bySource.set(id, c);
        }
        return c;
    }

    /** A store failure is logged and survived: the answer goes out without the cache. */
    private safe<T>(fn: () => T, fallback: T): T {
        try {
            return fn();
        } catch (err) {
            this.counters.storeErrors += 1;
            try {
                this.store.logEvent('error', (err as Error).message);
            } catch {
                // The store itself is unusable; the counter is all that is left.
            }
            return fallback;
        }
    }

    sessionOf(entry: CatalogEntry, session: string | undefined): string {
        return entry.class === 'stock' || entry.class === 'etf' ? (session === 'extended' ? 'extended' : 'regular') : 'all';
    }

    private settleMs(entry: CatalogEntry): number {
        return (entry.class === 'stock' || entry.class === 'etf' ? EQUITY_SETTLE_MS : SETTLE_MS) + (entry.delayMinutes ?? 0) * 60_000;
    }

    /**
     * The session state of a US-calendar instrument: whether it trades right now and when its
     * last session ended. Null for everything else, and when the calendar is slow or down.
     */
    private async sessionState(entry: CatalogEntry, session: string, now: number): Promise<{ open: boolean; lastEnd: number } | null> {
        if (!this.market.catalog.followsUsCalendar(entry)) return null;
        const windows = await Promise.race([
            this.market.calendar(entry.symbol, now - 6 * 86_400_000, now + 60_000, session === 'extended' ? 'extended' : 'regular').catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), CALENDAR_WAIT_MS).unref?.()),
        ]);
        if (!windows) return null;
        let lastEnd = 0;
        for (const [a, b] of windows) {
            if (now >= a && now < b) return { open: true, lastEnd: 0 };
            if (b <= now) lastEnd = Math.max(lastEnd, b);
        }
        return { open: false, lastEnd };
    }

    /** Bars opening before the returned time are final (the tape has settled past them). */
    private async settledCutoff(entry: CatalogEntry, tf: Timeframe, session: string, now: number): Promise<number> {
        const settle = this.settleMs(entry);
        const base = now - settle - nominalMs(tf);
        // Between sessions an intraday or daily bar cannot change any more; a weekly or
        // monthly one is still open and keeps the conservative rule.
        if (tf.unit === 'minute' || (tf.unit === 'day' && tf.n === 1)) {
            const st = await this.sessionState(entry, session, now);
            if (st && !st.open && st.lastEnd > 0 && now >= st.lastEnd + settle) return Math.max(base, now);
        }
        return base;
    }

    /** Whether the stored series already holds everything there is until the next session. */
    async isComplete(entry: CatalogEntry, s: SeriesRow, now: number): Promise<boolean> {
        const st = await this.sessionState(entry, s.session, now);
        return !!st && !st.open && st.lastEnd > 0 && s.fetchedAt >= st.lastEnd + this.settleMs(entry);
    }

    async bars(symbol: string, tfRaw: string, req: BarRequest): Promise<CachedBars> {
        const entry = this.market.resolve(symbol);
        const tf = parseTimeframe(tfRaw);
        if (!entry || !tf) return { ...(await this.market.getBars(symbol, tfRaw, req)), cache: 'passthrough' };
        const session = this.sessionOf(entry, req.session);
        const key = seriesKey(entry.symbol, tfRaw, session);
        const meta = { symbol: entry.symbol, tf: tfRaw, session, source: '' };
        const now = this.now();
        const initial = req.from == null && req.to == null;
        const limit = req.limit ?? 500;
        if (initial && limit < MIN_CACHED_LIMIT) {
            this.counters.passthrough += 1;
            return { ...(await this.market.getBars(symbol, tfRaw, req)), cache: 'passthrough' };
        }
        const s = this.safe(() => this.store.series(key), undefined);

        if (initial && s && Math.max(s.depth, s.bars) >= limit) {
            if (await this.isComplete(entry, s, now)) {
                const bars = this.safe(() => this.store.bars(key, { limit }), []);
                if (bars.length > 0) {
                    this.safe(() => this.store.touch(key), undefined);
                    this.counters.complete += 1;
                    const c = this.source(s.source);
                    c.avoided += 1;
                    c.barsFromCache += bars.length;
                    return { entry, source: s.source as BridgeId, bars, cache: 'complete' };
                }
            }
            // Re-fetch from the newest final bars on: they overlap what is stored, so a
            // history the provider has since rewritten (a split) is caught.
            const overlap = this.safe(() => this.store.bars(key, { to: s.settledTo - 1, limit: 2 }), []);
            if (overlap.length > 0) {
                const fresh = await this.market.getBars(symbol, tfRaw, { from: overlap[0]!.time, session: req.session });
                if (fresh.source === s.source) {
                    const cutoff = await this.settledCutoff(entry, tf, session, now);
                    const { replaced } = this.safe(() => this.store.write({ ...meta, source: fresh.source }, fresh.bars, { coverTo: cutoff, settledTo: cutoff, reachesNow: true }), { replaced: true });
                    if (!replaced) {
                        const bars = this.safe(() => this.store.bars(key, { limit }), []);
                        if (bars.length > 0) {
                            this.safe(() => this.store.touch(key), undefined);
                            this.counters.merged += 1;
                            const c = this.source(fresh.source);
                            c.tailOnly += 1;
                            const firstFresh = fresh.bars[0]?.time ?? Infinity;
                            const fromCache = bars.filter((b) => b.time < firstFresh).length;
                            c.barsFromCache += fromCache;
                            c.barsFromUpstream += bars.length - fromCache;
                            return { entry, source: fresh.source, bars, cache: 'merged' };
                        }
                    } else {
                        this.counters.replaced += 1;
                    }
                }
            }
        }

        // A backfill the stored stretch already holds.
        if (!initial && s && req.to != null && req.to < s.settledTo) {
            let bars: OHLCV[] | null = null;
            if (req.from != null) {
                if (req.from >= s.coveredFrom) bars = this.safe(() => this.store.bars(key, { from: req.from, to: req.to, limit: req.limit }), null);
            } else if (req.limit != null) {
                const got = this.safe(() => this.store.bars(key, { to: req.to, limit: req.limit }), []);
                if (got.length >= req.limit) bars = got;
            }
            if (bars && bars.length > 0) {
                this.safe(() => this.store.touch(key), undefined);
                this.counters.range += 1;
                const c = this.source(s.source);
                c.avoided += 1;
                c.barsFromCache += bars.length;
                return { entry, source: s.source as BridgeId, bars, cache: 'range' };
            }
        }

        const fresh = await this.market.getBars(symbol, tfRaw, req);
        this.counters.fetched += 1;
        const c = this.source(fresh.source);
        c.full += 1;
        c.barsFromUpstream += fresh.bars.length;
        if (fresh.bars.length > 0) {
            const cutoff = await this.settledCutoff(entry, tf, session, now);
            const reachesNow = req.to == null || req.to >= now - this.settleMs(entry);
            const coverTo = Math.min(req.to ?? Infinity, cutoff);
            const { replaced } = this.safe(
                () => this.store.write({ ...meta, source: fresh.source }, fresh.bars, { coverTo, settledTo: Math.min(cutoff, coverTo + 1), reachesNow, ...(initial ? { depth: limit } : {}) }),
                { replaced: false },
            );
            if (replaced) this.counters.replaced += 1;
        }
        return { ...fresh, cache: 'fetched' };
    }

    /** The stored bars alone, never a provider call — what a chart paints while it waits. */
    async peek(symbol: string, tfRaw: string, req: BarRequest): Promise<PeekedBars | null> {
        const entry = this.market.resolve(symbol);
        if (!entry || !parseTimeframe(tfRaw)) return null;
        const key = seriesKey(entry.symbol, tfRaw, this.sessionOf(entry, req.session));
        const limit = req.limit ?? 500;
        const s = this.safe(() => this.store.series(key), undefined);
        // A fragment (a few bars a short poll stored) would paint a near-empty chart first.
        const usable = s && (s.depth > 0 || s.bars >= Math.min(limit, PEEK_MIN_BARS));
        const bars = usable ? this.safe(() => this.store.bars(key, { limit }), []) : [];
        if (!s || bars.length === 0) {
            this.counters.peekMiss += 1;
            return null;
        }
        this.safe(() => this.store.touch(key), undefined);
        this.counters.peekHit += 1;
        return { bars, asOf: s.fetchedAt, complete: await this.isComplete(entry, s, this.now()), source: s.source };
    }

    async quotes(symbols: string[]): Promise<QuoteRow[]> {
        const rows = await this.market.quotes(symbols);
        this.safe(() => this.store.putQuotes(rows), undefined);
        return rows;
    }

    /** Last stored quote per symbol, each with when it was fetched. */
    peekQuotes(symbols: string[]): Array<QuoteRow & { asOf: number }> {
        const canonical = symbols.map((s) => this.market.resolve(s)?.symbol).filter((s): s is string => !!s);
        const got = this.safe(() => this.store.quotes(canonical), []);
        this.counters.quotePeekHit += got.length;
        this.counters.quotePeekMiss += canonical.length - got.length;
        return got.map((g) => ({ ...(g.row as QuoteRow), asOf: g.fetchedAt }));
    }
}
