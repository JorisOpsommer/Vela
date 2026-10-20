// Finnhub (free tier): no historical bars on this plan, but a real-time trade stream
// (US stocks, FX, crypto), single-symbol quotes, symbol search and company logos.
// The server holds ONE websocket for every browser.
import type { Bridge, OHLCV, Quote } from '../types';
import { UpstreamError } from '../types';
import { TokenBucket, TtlCache, fetchJson } from '../limits';

const REST = 'https://finnhub.io/api/v1';
const WS = 'wss://ws.finnhub.io';
/** Free-plan cap on concurrently streamed symbols. */
export const FINNHUB_MAX_STREAMS = 50;

export interface Trade {
    symbol: string;
    price: number;
    time: number;
    volume: number;
}

export class FinnhubBridge implements Bridge {
    readonly id = 'finnhub' as const;
    readonly pollMs = 30_000;
    // 60/min allowed; keep headroom for search and logos.
    private readonly bucket = new TokenBucket(50, 10, 'finnhub');
    private readonly quoteCache = new TtlCache<Quote | null>(500, 'finnhub');
    private readonly profileCache = new TtlCache<{ logo?: string; name?: string } | null>(2_000, 'finnhub');
    private ws: WebSocket | null = null;
    private readonly wanted = new Set<string>();
    private readonly listeners = new Set<(t: Trade) => void>();
    private readonly last = new Map<string, Trade>();
    private reconnectMs = 2_000;
    private closed = false;
    private trades = 0;
    private lastTradeAt = 0;

    constructor(private readonly key: string) {}

    supports(): boolean {
        return false;
    }

    getBars(): Promise<OHLCV[]> {
        return Promise.reject(new UpstreamError('Finnhub free tier serves no historical bars', 403));
    }

    private async get<T>(path: string, maxWaitMs = 10_000): Promise<T> {
        await this.bucket.take(maxWaitMs);
        return fetchJson<T>(`${REST}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.key)}`, { bridge: 'finnhub', tag: path.split('?')[0]!.slice(1) });
    }

    async quotes(tickers: string[]): Promise<Map<string, Quote>> {
        const out = new Map<string, Quote>();
        await Promise.all(
            tickers.map(async (t) => {
                const q = await this.quoteCache
                    .wrap(t, 20_000, async () => {
                        const r = await this.get<{ c: number; pc: number; t: number }>(`/quote?symbol=${encodeURIComponent(t)}`);
                        return r && r.c ? { price: r.c, prevClose: r.pc || null, time: r.t * 1000 } : null;
                    })
                    .catch(() => this.quoteCache.stale(t) ?? null);
                if (q) out.set(t, q);
            }),
        );
        return out;
    }

    /** Company logo URL (Finnhub CDN), cached for a day. Null = no logo; throws when
     *  the lookup itself failed (rate budget, network) so callers do not cache a miss. */
    async logoUrl(symbol: string): Promise<string | null> {
        const p = await this.profileCache.wrap(symbol, 24 * 3_600_000, async () => this.get<{ logo?: string; name?: string }>(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`, 60_000));
        return p?.logo ? p.logo : null;
    }

    lastTrade(symbol: string): Trade | undefined {
        return this.last.get(symbol);
    }

    onTrade(fn: (t: Trade) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Replace the streamed set (capped at the plan limit, in priority order). */
    setStreams(symbols: string[]): void {
        const next = new Set(symbols.slice(0, FINNHUB_MAX_STREAMS));
        for (const s of [...this.wanted]) {
            if (!next.has(s)) {
                this.wanted.delete(s);
                this.send({ type: 'unsubscribe', symbol: s });
            }
        }
        for (const s of next) {
            if (!this.wanted.has(s)) {
                this.wanted.add(s);
                this.send({ type: 'subscribe', symbol: s });
            }
        }
        if (!this.ws && this.wanted.size > 0) this.connect();
    }

    private send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    private connect(): void {
        if (this.closed) return;
        const ws = new WebSocket(`${WS}?token=${encodeURIComponent(this.key)}`);
        this.ws = ws;
        ws.onopen = () => {
            this.reconnectMs = 2_000;
            for (const s of this.wanted) ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
        };
        ws.onmessage = (ev) => {
            let msg: { type?: string; data?: Array<{ s: string; p: number; t: number; v: number }> };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.type !== 'trade' || !msg.data) return;
            // Keep the newest trade per symbol from each batch.
            const newest = new Map<string, Trade>();
            for (const d of msg.data) {
                const prev = newest.get(d.s);
                if (!prev || d.t >= prev.time) newest.set(d.s, { symbol: d.s, price: d.p, time: d.t, volume: d.v });
            }
            this.trades += msg.data.length;
            this.lastTradeAt = Date.now();
            for (const t of newest.values()) {
                this.last.set(t.symbol, t);
                for (const fn of this.listeners) fn(t);
            }
        };
        ws.onclose = () => {
            this.ws = null;
            if (this.closed || this.wanted.size === 0) return;
            setTimeout(() => this.connect(), this.reconnectMs).unref?.();
            this.reconnectMs = Math.min(this.reconnectMs * 2, 60_000);
        };
        ws.onerror = () => ws.close();
    }

    stats(): { connected: boolean; streams: number; trades: number; lastTradeAt: number | null } {
        return { connected: this.ws?.readyState === WebSocket.OPEN, streams: this.wanted.size, trades: this.trades, lastTradeAt: this.lastTradeAt || null };
    }

    close(): void {
        this.closed = true;
        this.ws?.close();
    }
}
