// Crypto from Coinbase's public market data (no key), reusing Vela's own Coinbase
// provider on the server: candles, plus a true live stream built from its ticker feed.
import { CoinbaseProvider } from '../../../../src/data/providers/coinbase';
import type { Bridge, BarRequest, OHLCV, Quote } from '../types';
import { TokenBucket, TtlCache, fetchJson } from '../limits';
import { metrics } from '../metrics';
import type { Timeframe } from '../timeframes';
import { aggregate, clip } from '../timeframes';

/** Canonical Vela timeframe string the Coinbase provider understands. */
export function velaTf(tf: Timeframe): string | null {
    if (tf.unit === 'minute') return String(tf.n);
    if (tf.n !== 1) return null;
    return tf.unit === 'day' ? 'D' : tf.unit === 'week' ? 'W' : 'M';
}

export class CoinbaseBridge implements Bridge {
    readonly id = 'coinbase' as const;
    readonly pollMs = 10_000;
    private readonly provider = new CoinbaseProvider();
    private readonly cache = new TtlCache<OHLCV[]>(300, 'coinbase');
    private readonly quoteCache = new TtlCache<Quote | null>(50, 'coinbase');
    private readonly bucket = new TokenBucket(120, 10, 'coinbase');

    supports(): boolean {
        return true;
    }

    async getBars(ticker: string, tf: Timeframe, req: BarRequest): Promise<OHLCV[]> {
        const native = velaTf(tf);
        const key = `${ticker}|${tf.unit}${tf.n}|${req.from ?? ''}|${req.to ?? ''}|${req.limit ?? ''}`;
        return this.cache.wrap(key, req.to != null && req.to < Date.now() - 3_600_000 ? 3_600_000 : 5_000, async () => {
            await this.bucket.take();
            // The provider pages and paces its own HTTP calls; one logical fetch is timed here.
            if (native) return metrics.time('coinbase', `candles:${native}`, () => this.provider.getBars(ticker, native, { from: req.from, to: req.to, limit: req.limit }));
            // nD / nW: fold daily candles.
            const daily = await metrics.time('coinbase', 'candles:D', () => this.provider.getBars(ticker, 'D', { from: req.from, to: req.to, limit: req.limit != null ? req.limit * tf.n * (tf.unit === 'week' ? 7 : 1) : undefined }));
            return clip(aggregate(daily, tf, 'Etc/UTC'), { limit: req.limit });
        });
    }

    subscribe(ticker: string, tf: Timeframe, onBar: (bar: OHLCV) => void): () => void {
        const native = velaTf(tf);
        if (!native) return () => undefined;
        return this.provider.subscribe(ticker, native, onBar);
    }

    async quotes(tickers: string[]): Promise<Map<string, Quote>> {
        const out = new Map<string, Quote>();
        await Promise.all(
            tickers.map(async (t) => {
                const q = await this.quoteCache
                    .wrap(t, 10_000, async () => {
                        await this.bucket.take();
                        const s = await fetchJson<{ open: string; last: string }>(`https://api.exchange.coinbase.com/products/${encodeURIComponent(t)}/stats`, { bridge: 'coinbase', tag: 'stats' });
                        const price = Number(s.last);
                        // 24 h market: change is measured against the price 24 hours ago.
                        return Number.isFinite(price) ? { price, prevClose: Number(s.open) || null, time: Date.now() } : null;
                    })
                    .catch(() => this.quoteCache.stale(t) ?? null);
                if (q) out.set(t, q);
            }),
        );
        return out;
    }
}
