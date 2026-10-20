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
}

/** One upstream market-data source. Every method may throw; the router falls back. */
export interface Bridge {
    readonly id: BridgeId;
    /** Whether this bridge can serve `tf` for `entry` (natively or by aggregation). */
    supports(tf: Timeframe, entry: CatalogEntry): boolean;
    getBars(ticker: string, tf: Timeframe, req: BarRequest, entry: CatalogEntry): Promise<OHLCV[]>;
    /** Batch quotes, keyed by the bridge's ticker. */
    quotes?(tickers: string[], entries: CatalogEntry[]): Promise<Map<string, Quote>>;
    /** How often the live hub refreshes the tail of an open chart from this bridge. */
    readonly pollMs: number;
}

export class UpstreamError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
    }
}
