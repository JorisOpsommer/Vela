// The options read for one underlying: fetch the chain (open interest from the broker's
// contract list, quotes and greeks from the indicative snapshots), analyze it, and keep
// the day's summary as history. The daily job reads every watched symbol after the close;
// the options page loads a symbol nobody watched yet on demand.
import type { Db } from '../db';
import type { MarketService } from '../market/service';
import type { AlpacaAsset } from '../market/bridges/alpaca';
import { TtlCache } from '../market/limits';
import { localDate } from '../market/timeframes';
import { UpstreamError } from '../market/types';
import { analyzeChain, buildChain, chainWindow, type OptionsDetail, type OptionsSummary, type StrikeRow } from './chain';

const NY = 'America/New_York';
const DAY_MS = 86_400_000;
/** Summaries are kept this long (a year of trading days for the IV rank, plus slack). */
const SUMMARY_KEEP_DAYS = 400;
/** Open interest by strike is kept this long (day-over-day change, short trends). */
const STRIKES_KEEP_DAYS = 30;
/** An on-demand read is reused this long. */
const READ_TTL_MS = 20 * 60_000;

/** The broker's margin and lending terms for a stock — its own house rules, not the exchange's. */
export interface AssetTerms {
    marginable: boolean;
    /** Percent of position value required to open a long / a short, and to hold it. */
    marginLong: number | null;
    marginShort: number | null;
    maintenance: number | null;
    shortable: boolean;
    easyToBorrow: boolean;
    hasOptions: boolean;
}

export interface OptionsRead {
    symbol: string;
    fetchedAt: number;
    summary: OptionsSummary;
    detail: OptionsDetail;
}

export interface StoredDay {
    date: string;
    fetchedAt: number;
    summary: OptionsSummary;
    strikes: StrikeRow[] | null;
}

const pct = (v: number | string | undefined): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return v != null && Number.isFinite(n) ? n : null;
};

export function assetTerms(a: AlpacaAsset): AssetTerms {
    return {
        marginable: a.marginable === true,
        marginLong: pct(a.margin_requirement_long),
        marginShort: pct(a.margin_requirement_short),
        maintenance: pct(a.maintenance_margin_requirement),
        shortable: a.shortable === true,
        easyToBorrow: a.easy_to_borrow === true,
        hasOptions: a.attributes?.includes('has_options') === true,
    };
}

export class OptionsService {
    private readonly reads = new TtlCache<OptionsRead>(500);
    private terms: Map<string, AssetTerms> | null = null;
    private termsFor: AlpacaAsset[] | null = null;

    constructor(
        private readonly db: Db,
        private readonly market: MarketService,
        private readonly now: () => number = Date.now,
    ) {}

    get available(): boolean {
        return !!this.market.bridges.alpaca;
    }

    /** The broker's terms for `symbol`, from the daily asset list (no request of its own once loaded). */
    async assetTerms(symbol: string): Promise<AssetTerms | null> {
        const alpaca = this.market.bridges.alpaca;
        if (!alpaca) return null;
        const assets = await alpaca.assets().catch(() => null);
        if (!assets) return null;
        if (this.termsFor !== assets) {
            this.terms = new Map(assets.map((a) => [a.symbol.toUpperCase(), assetTerms(a)]));
            this.termsFor = assets;
        }
        return this.terms!.get(symbol.toUpperCase()) ?? null;
    }

    /** Whether `symbol` is a US stock or ETF with listed options (unknown terms count as yes). */
    async optionable(symbol: string): Promise<boolean> {
        const entry = this.market.resolve(symbol);
        if (!entry || (entry.class !== 'stock' && entry.class !== 'etf')) return false;
        const terms = await this.assetTerms(entry.symbol);
        return terms ? terms.hasOptions : true;
    }

    /** The trading day a read made now describes: the latest session that has opened. */
    async sessionDate(): Promise<string> {
        const t = this.now();
        const cal = await this.market.bridges.alpaca?.calendar(t - 10 * DAY_MS, t).catch(() => null);
        if (cal) {
            const days = [...cal.entries()].filter(([, d]) => d.open <= t).map(([date]) => date).sort();
            if (days.length > 0) return days[days.length - 1]!;
        }
        return localDate(NY, t);
    }

    /** Fetch, analyze and store `symbol`'s chain. Concurrent and recent reads share one fetch. */
    read(symbol: string): Promise<OptionsRead> {
        const entry = this.market.resolve(symbol);
        if (!entry) return Promise.reject(new UpstreamError(`Unknown symbol ${symbol}.`, 400));
        return this.reads.wrap(entry.symbol, READ_TTL_MS, () => this.fetch(entry.symbol));
    }

    private async fetch(symbol: string): Promise<OptionsRead> {
        const alpaca = this.market.bridges.alpaca;
        if (!alpaca) throw new UpstreamError('Options need the Alpaca keys.', 409);
        if (!(await this.optionable(symbol))) throw new UpstreamError(`${symbol} has no listed options.`, 409);
        const [quote] = await this.market.quotes([symbol]);
        if (!quote) throw new UpstreamError(`No price for ${symbol}.`, 502);
        const t = this.now();
        const w = chainWindow(quote.price, t);
        const [contracts, snaps, date] = await Promise.all([alpaca.optionContracts(symbol, w), alpaca.optionSnapshots(symbol, w), this.sessionDate()]);
        if (contracts.length === 0) throw new UpstreamError(`${symbol} has no listed options.`, 409);
        const chain = buildChain(contracts, snaps, quote.price, t, date);
        const oiDate = contracts.reduce<string | null>((a, c) => (c.open_interest_date && (!a || c.open_interest_date > a) ? c.open_interest_date : a), null);
        const { summary, detail } = analyzeChain(chain, quote.price, t, date, oiDate);
        this.store(symbol, t, summary, detail);
        return { symbol, fetchedAt: t, summary, detail };
    }

    private store(symbol: string, at: number, summary: OptionsSummary, detail: OptionsDetail): void {
        this.db
            .prepare('INSERT INTO options_daily (symbol, date, fetched_at, summary, strikes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol, date) DO UPDATE SET fetched_at = excluded.fetched_at, summary = excluded.summary, strikes = excluded.strikes')
            .run(symbol, summary.date, at, JSON.stringify(summary), JSON.stringify(detail.strikes));
        this.db
            .prepare('INSERT INTO options_latest (symbol, date, fetched_at, detail) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET date = excluded.date, fetched_at = excluded.fetched_at, detail = excluded.detail')
            .run(symbol, summary.date, at, JSON.stringify(detail));
    }

    /** Whether `symbol` already has a read for `date`. */
    has(symbol: string, date: string): boolean {
        return !!this.db.prepare('SELECT 1 FROM options_daily WHERE symbol = ? AND date = ?').get(symbol, date);
    }

    /** The newest stored read, if any. */
    latest(symbol: string): OptionsRead | null {
        const row = this.db.prepare('SELECT date, fetched_at, detail FROM options_latest WHERE symbol = ?').get(symbol) as { date: string; fetched_at: number; detail: string } | undefined;
        if (!row) return null;
        const day = this.db.prepare('SELECT summary FROM options_daily WHERE symbol = ? AND date = ?').get(symbol, row.date) as { summary: string } | undefined;
        if (!day) return null;
        return { symbol, fetchedAt: row.fetched_at, summary: JSON.parse(day.summary) as OptionsSummary, detail: JSON.parse(row.detail) as OptionsDetail };
    }

    /** Stored days, newest first. */
    history(symbol: string, limit = 260): StoredDay[] {
        const rows = this.db.prepare('SELECT date, fetched_at, summary, strikes FROM options_daily WHERE symbol = ? ORDER BY date DESC LIMIT ?').all(symbol, limit) as Array<{
            date: string;
            fetched_at: number;
            summary: string;
            strikes: string | null;
        }>;
        return rows.map((r) => ({ date: r.date, fetchedAt: r.fetched_at, summary: JSON.parse(r.summary) as OptionsSummary, strikes: r.strikes ? (JSON.parse(r.strikes) as StrikeRow[]) : null }));
    }

    /** Drop summaries past their keep and the per-strike detail past its shorter one. */
    prune(): void {
        const t = this.now();
        this.db.prepare('DELETE FROM options_daily WHERE date < ?').run(localDate(NY, t - SUMMARY_KEEP_DAYS * DAY_MS));
        this.db.prepare('UPDATE options_daily SET strikes = NULL WHERE strikes IS NOT NULL AND date < ?').run(localDate(NY, t - STRIKES_KEEP_DAYS * DAY_MS));
    }
}

/** Where the 30-day IV sits within its stored range (0 = lowest seen, 1 = highest), once there is a range. */
export function ivRank(days: readonly StoredDay[]): { rank: number; days: number } | null {
    const ivs = days.map((d) => d.summary.iv30).filter((v): v is number => v != null);
    if (ivs.length < 5) return null;
    const lo = Math.min(...ivs);
    const hi = Math.max(...ivs);
    return hi > lo ? { rank: (ivs[0]! - lo) / (hi - lo), days: ivs.length } : null;
}
