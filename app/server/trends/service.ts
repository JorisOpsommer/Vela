// Trend reads per symbol: detected on the cached 4h, Daily and Weekly bars (settled bars only),
// stored with the detector version and the newest bar they used, so a read is redone only
// when a new bar settles or the detector changes. A symbol with nothing cached is loaded
// through the cache on demand.
import type { Db } from '../db';
import type { CachedMarket } from '../market/cached-market';
import { seriesKey } from '../market/cache-store';
import { detect, markConfluence, type Detection, type TrendTf } from './detect';

/** Bump when the detector's output changes: every stored read is redone on its next pass. */
export const DETECTOR_VERSION = 1;
export const TREND_TIMEFRAMES: readonly TrendTf[] = ['240', 'D', 'W'];
const DEPTH = 1_000;

export type TrendReads = Partial<Record<TrendTf, Detection>>;

export class TrendsService {
    constructor(
        private readonly db: Db,
        private readonly cached: CachedMarket,
        private readonly now: () => number = Date.now,
    ) {}

    /** The settled bars of `symbol` at `tf` the cache holds, oldest first: the regular
     *  session's, or the extended one's when only that is cached (accounts that chart
     *  extended hours get their watchlist warmed that way). */
    private settledBars(symbol: string, tf: TrendTf) {
        const entry = this.cached.market.resolve(symbol);
        if (!entry) return [];
        for (const session of new Set([this.cached.sessionOf(entry, 'regular'), this.cached.sessionOf(entry, 'extended')])) {
            const key = seriesKey(entry.symbol, tf, session);
            const s = this.cached.store.series(key);
            if (s) return this.cached.store.bars(key, { to: s.settledTo - 1, limit: DEPTH });
        }
        return [];
    }

    /**
     * Detect `symbol` on every timeframe from the cache, when a new bar settled or the
     * detector changed since the stored read. Returns whether anything was redone.
     */
    refresh(symbol: string): boolean {
        const bars = Object.fromEntries(TREND_TIMEFRAMES.map((tf) => [tf, this.settledBars(symbol, tf)])) as Record<TrendTf, ReturnType<TrendsService['settledBars']>>;
        const stored = this.stamps(symbol);
        const due = TREND_TIMEFRAMES.some((tf) => {
            const last = bars[tf].at(-1)?.time;
            const s = stored.get(tf);
            return last != null && (!s || s.asOf !== last || s.version !== DETECTOR_VERSION);
        });
        if (!due) return false;
        const reads: TrendReads = {};
        for (const tf of TREND_TIMEFRAMES) {
            const d = detect(bars[tf], tf);
            if (d) reads[tf] = d;
        }
        markConfluence(reads.W ?? null, reads.D ?? null);
        markConfluence(reads.D ?? null, reads['240'] ?? null);
        const put = this.db.prepare(
            'INSERT INTO trend_reads (symbol, tf, version, as_of, computed_at, read) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, tf) DO UPDATE SET version = excluded.version, as_of = excluded.as_of, computed_at = excluded.computed_at, read = excluded.read',
        );
        for (const tf of TREND_TIMEFRAMES) {
            const d = reads[tf];
            if (d) put.run(symbol, tf, DETECTOR_VERSION, d.asOf, this.now(), JSON.stringify(d));
        }
        return true;
    }

    private stamps(symbol: string): Map<string, { asOf: number; version: number }> {
        const rows = this.db.prepare('SELECT tf, as_of, version FROM trend_reads WHERE symbol = ?').all(symbol) as Array<{ tf: string; as_of: number; version: number }>;
        return new Map(rows.map((r) => [r.tf, { asOf: r.as_of, version: r.version }]));
    }

    /** Stored reads of `symbol` from the current detector. */
    reads(symbol: string): TrendReads {
        const rows = this.db.prepare('SELECT tf, read FROM trend_reads WHERE symbol = ? AND version = ?').all(symbol, DETECTOR_VERSION) as Array<{ tf: TrendTf; read: string }>;
        return Object.fromEntries(rows.map((r) => [r.tf, JSON.parse(r.read) as Detection]));
    }

    /** Reads for a symbol someone opened: loads its bars through the cache first when it holds none. */
    async readNow(symbol: string): Promise<TrendReads> {
        const entry = this.cached.market.resolve(symbol);
        if (!entry) return {};
        const missing = TREND_TIMEFRAMES.filter((tf) => this.settledBars(entry.symbol, tf).length === 0);
        await Promise.all(missing.map((tf) => this.cached.bars(entry.symbol, tf, { limit: DEPTH, session: 'regular' }).catch(() => null)));
        this.refresh(entry.symbol);
        return this.reads(entry.symbol);
    }
}
