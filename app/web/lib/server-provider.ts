// The browser's only data provider: every request goes to this app's own server, which
// holds the API keys and picks the upstream source per symbol. One websocket carries
// every live subscription.
import type { DataProvider, ProviderInfo, SymbolDescriptor, SymbolInfo, BarRange, OHLCV } from '../../../src';
import { ApiError, api } from './api';

type Unsubscribe = () => void;

const TIMEFRAMES = ['1', '2', '3', '5', '10', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', '2D', '3D', 'W', '2W', 'M'];

class StreamClient {
    private ws: WebSocket | null = null;
    private nextId = 1;
    private readonly subs = new Map<number, { symbol: string; tf: string; session?: string; onBar: (b: OHLCV) => void }>();
    private retryMs = 1_000;
    private closedByUs = false;

    subscribe(symbol: string, tf: string, session: string | undefined, onBar: (b: OHLCV) => void): Unsubscribe {
        const id = this.nextId++;
        this.subs.set(id, { symbol, tf, session, onBar });
        this.ensure();
        this.send({ op: 'sub', id, symbol, tf, session });
        return () => {
            this.subs.delete(id);
            this.send({ op: 'unsub', id });
        };
    }

    private send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    private ensure(): void {
        if (this.ws || this.closedByUs) return;
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
        this.ws = ws;
        ws.onopen = () => {
            this.retryMs = 1_000;
            for (const [id, s] of this.subs) ws.send(JSON.stringify({ op: 'sub', id, symbol: s.symbol, tf: s.tf, session: s.session }));
        };
        ws.onmessage = (ev) => {
            let msg: { op?: string; id?: number; bar?: OHLCV };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.op === 'bar' && msg.id != null && msg.bar) this.subs.get(msg.id)?.onBar(msg.bar);
        };
        ws.onclose = () => {
            this.ws = null;
            if (this.subs.size === 0 || this.closedByUs) return;
            setTimeout(() => this.ensure(), this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, 30_000);
        };
    }

    close(): void {
        this.closedByUs = true;
        this.ws?.close();
    }
}

/** The server could not load bars because the sources for them are over their rate limit. */
export interface ProviderLimitEvent {
    symbol: string;
    timeframe: string;
    providers: string[];
    retryAfterSec: number;
}

export interface ServerProviderOptions {
    onProviderLimit?: (e: ProviderLimitEvent) => void;
}

export class ServerProvider implements DataProvider {
    constructor(private readonly opts: ServerProviderOptions = {}) {}

    private readonly stream = new StreamClient();
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;
    private readonly infoCache = new Map<string, Promise<SymbolInfo | undefined>>();
    private readonly calendarCache = new Map<string, { at: number; value: Promise<ReadonlyArray<readonly [number, number]>> }>();

    info(): ProviderInfo {
        return {
            name: 'market',
            displayName: 'Market data',
            supportedTimeframes: TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const q = new URLSearchParams({ symbol: ticker, tf: timeframe });
        if (range.from != null) q.set('from', String(Math.floor(range.from)));
        if (range.to != null) q.set('to', String(Math.floor(range.to)));
        if (range.limit != null) q.set('limit', String(range.limit));
        if (range.session) q.set('session', range.session);
        try {
            const r = await api<{ bars: OHLCV[] }>(`/api/bars?${q}`);
            return r.bars;
        } catch (err) {
            if (err instanceof ApiError && err.status === 429 && err.body.code === 'provider_limit') {
                const providers = Array.isArray(err.body.providers) ? err.body.providers.filter((p): p is string => typeof p === 'string') : [];
                const retryAfterSec = typeof err.body.retryAfterSec === 'number' ? err.body.retryAfterSec : 60;
                this.opts.onProviderLimit?.({ symbol: ticker, timeframe, providers, retryAfterSec });
            }
            throw err;
        }
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        this.symbolsPromise ??= api<SymbolDescriptor[]>('/api/symbols').catch(() => {
            this.symbolsPromise = null;
            return [];
        });
        return this.symbolsPromise;
    }

    getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const key = ticker.toUpperCase();
        let p = this.infoCache.get(key);
        if (!p) {
            p = api<SymbolInfo>(`/api/symbol-info?symbol=${encodeURIComponent(ticker)}`).catch(() => undefined);
            this.infoCache.set(key, p);
        }
        return p;
    }

    resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
        if (symbol.type !== 'stock' && symbol.type !== 'etf' && symbol.type !== 'crypto') return undefined;
        return `/api/logo/${encodeURIComponent(symbol.ticker)}`;
    }

    getCalendar(ticker: string, range: { from: number; to: number; session?: string }): Promise<ReadonlyArray<readonly [number, number]>> {
        // Hour-rounded so the badge's frequent re-evaluations hit the cache.
        const from = Math.floor(range.from / 3_600_000) * 3_600_000;
        const to = Math.ceil(range.to / 3_600_000) * 3_600_000;
        const key = `${ticker}|${from}|${to}|${range.session ?? 'regular'}`;
        const hit = this.calendarCache.get(key);
        if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
        const value = api<{ windows: Array<[number, number]> | null }>(`/api/calendar?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&session=${range.session ?? 'regular'}`).then(
            (r) => r.windows ?? [[from, to] as [number, number]],
        );
        value.catch(() => this.calendarCache.delete(key));
        this.calendarCache.set(key, { at: Date.now(), value });
        return value;
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void, opts?: { session?: string }): Unsubscribe {
        return this.stream.subscribe(ticker, timeframe, opts?.session, onBar);
    }
}
