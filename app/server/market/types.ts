// The server's market-data vocabulary. Bars use Vela's own OHLCV shape so the browser
// provider passes them through untouched.
import type { OHLCV } from '../../../src';
import type { Timeframe } from './timeframes';

export type { OHLCV };

export type AssetClass = 'stock' | 'etf' | 'crypto' | 'index' | 'forex' | 'futures' | 'power';

export type BridgeId = 'alpaca' | 'finnhub' | 'yahoo' | 'energycharts' | 'coinbase';

/** One way to fetch a catalog symbol: which bridge, and that bridge's own ticker. */
export interface SourceRef {
    bridge: BridgeId;
    ticker: string;
}

export interface CatalogEntry {
    /** App-level ticker the user sees and types (`AAPL`, `BTCUSD`, `BRENT`). */
    symbol: string;
    name: string;
    class: AssetClass;
    /** Display venue prefix (`NASDAQ`, `INDEX`, `CRYPTO`, …). */
    prefix: string;
    /** Ordered: the first healthy source wins; later ones are fallbacks. */
    sources: SourceRef[];
    /** Live tick source (trade stream), when one exists. */
    live?: SourceRef;
    currency: string;
    /** IANA zone the venue's calendar runs in (bucketing + session display). */
    timezone: string;
    /** Session spec (`0930-1600`, `24x7`, …) for the chart's market-status badge. */
    session: string;
    /** Quote decimals hint. */
    decimals?: number;
    /** Minutes the data runs behind the market; absent = real time. */
    delayMinutes?: number;
}

export interface BarRequest {
    from?: number;
    to?: number;
    limit?: number;
    /** `regular` | `extended` — only US equities distinguish them. */
    session?: string;
}

export interface Quote {
    price: number;
    /** Previous session close, for change / change %. */
    prevClose: number | null;
    time: number;
    /** The latest pre/post-market trade, when it is newer than the regular session. */
    extended?: ExtendedQuote;
}

/** A US equity's latest trade outside regular hours. */
export interface ExtendedQuote {
    session: 'pre' | 'post';
    price: number;
    /** The regular-session close it moves from: the same day's for post-market, the
     *  previous trading day's for pre-market. */
    base: number | null;
    time: number;
}

/** One upstream market-data source. Every method may throw; the router falls back. */
export interface Bridge {
    readonly id: BridgeId;
    /** Whether this bridge can serve `tf` for `entry` (natively or by aggregation). */
    supports(tf: Timeframe, entry: CatalogEntry): boolean;
    getBars(ticker: string, tf: Timeframe, req: BarRequest, entry: CatalogEntry): Promise<OHLCV[]>;
    /** Batch quotes, keyed by the bridge's ticker. */
    quotes?(tickers: string[], entries: CatalogEntry[]): Promise<Map<string, Quote>>;
    /** Real-time pre/post-market prices, served from spare request budget only: a ticker
     *  missing from the answer was not fetched (budget, failure, no extended trade). */
    extendedQuotes?(tickers: string[]): Promise<Map<string, ExtendedQuote>>;
    /** How often the live hub refreshes the tail of an open chart from this bridge. */
    readonly pollMs: number;
}

export class UpstreamError extends Error {
    /** `retryAfterMs`: for a 429, when the source is expected to accept requests again. */
    constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
        super(message);
    }
}

/** No source could serve a request because every one that failed was over its rate limit. */
export class ProviderLimitError extends UpstreamError {
    constructor(readonly providers: BridgeId[], retryAfterMs: number) {
        super(`Rate limit reached for ${providers.join(', ')}.`, 429, retryAfterMs);
    }
}

/** Fallback wait when a source says "too many requests" without saying for how long. */
const DEFAULT_RETRY_MS = 60_000;

/**
 * The rate-limit wait an error stands for, or null when it is some other failure. Our own
 * budget and upstream 429s carry a status; a library error only carries the code in text.
 */
export function rateLimitWait(err: unknown): number | null {
    if (err instanceof UpstreamError) return err.status === 429 ? (err.retryAfterMs ?? DEFAULT_RETRY_MS) : null;
    return err instanceof Error && /\b429\b|rate.?limit/i.test(err.message) ? DEFAULT_RETRY_MS : null;
}
