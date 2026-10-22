// The browser's only data provider: every request goes to this app's own server, which
// holds the API keys and picks the upstream source per symbol. One websocket carries
// every live subscription.
import type { DataProvider, PeekedBars, ProviderInfo, SymbolDescriptor, SymbolInfo, BarRange, OHLCV } from '../../../src';
import { ApiError, api } from './api';
import { reportTiming } from './timing';

type Unsubscribe = () => void;

/** A tab hidden this long drops its live stream until it is shown again. */
const HIDDEN_PARK_MS = 5 * 60_000;
/** Loads at least this deep are chart opens (smaller ones are tail refreshes). */
const OPEN_MIN_BARS = 50;

const TIMEFRAMES = ['1', '2', '3', '5', '10', '15', '30', '45', '60', '120', '180', '240', '360', '480', '720', 'D', '2D', '3D', 'W', '2W', 'M'];

class StreamClient {
    private ws: WebSocket | null = null;
    private nextId = 1;
    private readonly subs = new Map<number, { symbol: string; tf: string; session?: string; onBar: (b: OHLCV) => void }>();
    private retryMs = 1_000;
    private closedByUs = false;
    /** Dropped while the tab sat hidden: the server's providers go quiet, the cache can warm. */
    private parked = false;
    private parkTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.parkTimer ??= setTimeout(() => this.park(), HIDDEN_PARK_MS);
                return;
            }
            if (this.parkTimer) clearTimeout(this.parkTimer);
            this.parkTimer = null;
            if (this.parked) {
                // The chart heals the gap itself when the tab returns; resubscribing is all it takes.
                this.parked = false;
                this.ensure();
            }
        });
    }

    private park(): void {
        this.parkTimer = null;
        if (document.visibilityState !== 'hidden' || !this.ws) return;
        this.parked = true;
        this.ws.close();
    }

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
        if (this.ws || this.closedByUs || this.parked) return;
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
            if (this.subs.size === 0 || this.closedByUs || this.parked) return;
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
    /** Chart opens in flight, for the first-paint timings: when each began, whether held bars painted. */
    private readonly opening = new Map<string, { t0: number; painted: boolean }>();

    private openKey(ticker: string, timeframe: string, range: BarRange): string | null {
        if (range.from != null || range.to != null || (range.limit ?? 0) < OPEN_MIN_BARS) return null;
        return `${ticker.toUpperCase()}|${timeframe}|${range.session ?? ''}`;
    }

    private beginOpen(key: string): { t0: number; painted: boolean } {
        let o = this.opening.get(key);
        if (!o || performance.now() - o.t0 > 60_000) {
            o = { t0: performance.now(), painted: false };
            this.opening.set(key, o);
        }
        return o;
    }

    /** The bars the server already holds — an instant paint while {@link getBars} runs. */
    async peekBars(ticker: string, timeframe: string, range: BarRange): Promise<PeekedBars | null> {
        const key = this.openKey(ticker, timeframe, range);
        const open = key ? this.beginOpen(key) : null;
        const q = new URLSearchParams({ symbol: ticker, tf: timeframe, cache: 'only' });
        if (range.limit != null) q.set('limit', String(range.limit));
        if (range.session) q.set('session', range.session);
        const r = await api<{ bars: OHLCV[]; asOf: number | null; complete: boolean }>(`/api/bars?${q}`).catch(() => null);
        if (!r || r.bars.length === 0 || r.asOf == null) return null;
        if (open && !open.painted) {
            open.painted = true;
            reportTiming(r.complete ? 'complete' : 'cached', performance.now() - open.t0);
        }
        return { bars: r.bars, asOf: r.asOf, complete: r.complete };
    }

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
        const key = this.openKey(ticker, timeframe, range);
        const open = key ? this.beginOpen(key) : null;
        try {
            const r = await api<{ bars: OHLCV[] }>(`/api/bars?${q}`);
            if (open && key) {
                if (!open.painted && r.bars.length > 0) reportTiming('cold', performance.now() - open.t0);
                this.opening.delete(key);
            }
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
