// The live hub: one upstream driver per (symbol, timeframe, session), shared by every
// browser watching it. Drivers stream where the source can (Coinbase), poll the tail
// otherwise, and fold real-time trades (Finnhub) into the forming bar between polls.
import type { CatalogEntry, OHLCV } from './types';
import type { MarketService } from './service';
import { bucketStart, localTimeOfDay, nominalMs, parseTimeframe, type Timeframe } from './timeframes';
import { runAsUpkeep } from './background';

type Listener = (bar: OHLCV) => void;

interface Topic {
    key: string;
    entry: CatalogEntry;
    tf: Timeframe;
    session: string;
    listeners: Set<Listener>;
    last: OHLCV | null;
    stops: Array<() => void>;
    pendingTick: ReturnType<typeof setTimeout> | null;
    lastPush: number;
}

/** Trades are coalesced into at most one forming-bar push per topic per this interval. */
const TICK_FLUSH_MS = 400;

export class LiveHub {
    private readonly topics = new Map<string, Topic>();

    constructor(private readonly market: MarketService, private readonly onStreamsChanged?: () => void) {}

    /** Symbols with an open chart, for the trade stream's priority list. */
    activeLiveTickers(): string[] {
        const out = new Set<string>();
        for (const t of this.topics.values()) if (t.entry.live) out.add(t.entry.live.ticker);
        return [...out];
    }

    subscribe(symbol: string, tfRaw: string, session: string | undefined, fn: Listener): () => void {
        const entry = this.market.resolve(symbol);
        const tf = parseTimeframe(tfRaw);
        if (!entry || !tf) throw new Error('unknown symbol or timeframe');
        const sess = entry.class === 'stock' || entry.class === 'etf' ? (session === 'extended' ? 'extended' : 'regular') : 'all';
        const key = `${entry.symbol}|${tfRaw}|${sess}`;
        let topic = this.topics.get(key);
        if (!topic) {
            topic = { key, entry, tf, session: sess, listeners: new Set(), last: null, stops: [], pendingTick: null, lastPush: 0 };
            this.topics.set(key, topic);
            this.start(topic, tfRaw);
            this.onStreamsChanged?.();
        }
        topic.listeners.add(fn);
        if (topic.last) fn(topic.last);
        const t = topic;
        return () => {
            t.listeners.delete(fn);
            if (t.listeners.size === 0) this.stop(t);
        };
    }

    private start(topic: Topic, tfRaw: string): void {
        const primary = topic.entry.sources.find((s) => this.market.bridge(s.bridge));
        const coinbase = this.market.bridges.coinbase;
        if (primary?.bridge === 'coinbase' && coinbase) {
            topic.stops.push(coinbase.subscribe(primary.ticker, topic.tf, (bar) => this.emit(topic, bar)));
        } else {
            this.startPolling(topic, tfRaw, primary ? this.market.bridge(primary.bridge)!.pollMs : 60_000);
        }
        const finnhub = this.market.bridges.finnhub;
        if (topic.entry.live?.bridge === 'finnhub' && finnhub) {
            const liveTicker = topic.entry.live.ticker;
            topic.stops.push(
                finnhub.onTrade((trade) => {
                    if (trade.symbol === liveTicker) this.applyTrade(topic, trade.price, trade.time);
                }),
            );
        }
    }

    private startPolling(topic: Topic, tfRaw: string, everyMs: number): void {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const poll = async () => {
            if (stopped) return;
            try {
                // An open chart keeping itself current is upkeep, not someone charting.
                const { bars } = await runAsUpkeep(() => this.market.getBars(topic.entry.symbol, tfRaw, { limit: 3, session: topic.session === 'extended' ? 'extended' : 'regular' }));
                if (stopped) return;
                for (const b of bars) {
                    if (!topic.last || b.time >= topic.last.time) this.emit(topic, b);
                }
            } catch {
                // Transient upstream failure — the next poll retries.
            }
            if (!stopped) timer = setTimeout(() => void poll(), everyMs);
        };
        timer = setTimeout(() => void poll(), Math.min(everyMs, 5_000));
        topic.stops.push(() => {
            stopped = true;
            if (timer) clearTimeout(timer);
        });
    }

    /** Fold one trade into the forming bar. Equities never open a bar from a trade (the
     *  poll owns bar boundaries and session rules); 24h markets may. */
    applyTrade(topic: Topic, price: number, time: number): void {
        const last = topic.last;
        const equity = topic.entry.class === 'stock' || topic.entry.class === 'etf';
        if (equity && topic.session === 'regular') {
            const tod = localTimeOfDay('America/New_York', time);
            if (tod < 9.5 * 3_600_000 || tod >= 16 * 3_600_000) return;
        }
        if (!last || time < last.time) return;
        const inLast = topic.tf.unit === 'minute' ? time < last.time + nominalMs(topic.tf) : bucketStart(topic.tf, time, topic.entry.timezone) === last.time;
        if (inLast) {
            topic.last = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
        } else if (!equity) {
            const open = bucketStart(topic.tf, time, topic.entry.timezone);
            if (open <= last.time) return;
            topic.last = { time: open, open: price, high: price, low: price, close: price, volume: 0 };
        } else {
            return;
        }
        this.schedulePush(topic);
    }

    /** Coalesce forming-bar updates: at most one push per {@link TICK_FLUSH_MS}. */
    private schedulePush(topic: Topic): void {
        if (topic.pendingTick) return;
        const wait = Math.max(0, topic.lastPush + TICK_FLUSH_MS - Date.now());
        topic.pendingTick = setTimeout(() => {
            topic.pendingTick = null;
            topic.lastPush = Date.now();
            if (topic.last) for (const fn of topic.listeners) fn(topic.last);
        }, wait);
    }

    private emit(topic: Topic, bar: OHLCV): void {
        // Keep a trade-extended range when the poll's (slightly older) bar comes in.
        const merged = topic.last && topic.last.time === bar.time ? { ...bar, high: Math.max(bar.high, topic.last.high), low: Math.min(bar.low, topic.last.low) } : bar;
        if (topic.last && merged.time < topic.last.time) return;
        if (topic.last && merged.time > topic.last.time) {
            // A new bar: deliver the closing state of the previous one first, unthrottled.
            const closing = topic.last;
            if (topic.pendingTick) {
                clearTimeout(topic.pendingTick);
                topic.pendingTick = null;
            }
            for (const fn of topic.listeners) fn(closing);
            topic.last = merged;
            topic.lastPush = Date.now();
            for (const fn of topic.listeners) fn(merged);
            return;
        }
        topic.last = merged;
        this.schedulePush(topic);
    }

    private stop(topic: Topic): void {
        for (const s of topic.stops) s();
        if (topic.pendingTick) clearTimeout(topic.pendingTick);
        this.topics.delete(topic.key);
        this.onStreamsChanged?.();
    }

    stats(): { topics: number; listeners: number } {
        let listeners = 0;
        for (const t of this.topics.values()) listeners += t.listeners.size;
        return { topics: this.topics.size, listeners };
    }
}
