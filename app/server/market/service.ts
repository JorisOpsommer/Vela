// The router in front of the bridges: resolves a symbol to its catalog entry, tries each
// source in order (skipping bridges that keep failing), merges real-time trades into
// quotes, and runs the live hub that streams forming bars to browsers.
import type { Bridge, BridgeId, BarRequest, CatalogEntry, ExtendedQuote, OHLCV, Quote } from './types';
import { ProviderLimitError, UpstreamError, rateLimitWait } from './types';
import type { Catalog } from './catalog';
import { bucketStart, clip, localDate, localTimeOfDay, parseTimeframe, zonedWallTime, type Timeframe } from './timeframes';
import type { AlpacaBridge } from './bridges/alpaca';
import type { FinnhubBridge, Trade } from './bridges/finnhub';
import type { CoinbaseBridge } from './bridges/coinbase';
import { avoids } from './background';
import { BackgroundYield } from './limits';

export interface QuoteRow {
    symbol: string;
    price: number;
    prevClose: number | null;
    change: number | null;
    changePct: number | null;
    time: number;
    source: BridgeId;
    /** The latest pre/post-market trade while the regular session is closed. */
    extended?: { session: 'pre' | 'post'; price: number; change: number | null; changePct: number | null; time: number };
}

/** How far back the real-time extended-hours tail reaches: past the consolidated tape's delay. */
const EXTENDED_TAIL_MS = 20 * 60_000;

interface Health {
    failures: number;
    openUntil: number;
}

/** After this many consecutive failures a bridge is skipped for {@link BREAKER_MS}. */
const BREAKER_FAILURES = 3;
const BREAKER_MS = 60_000;

export interface Bridges {
    alpaca?: AlpacaBridge;
    finnhub?: FinnhubBridge;
    yahoo?: Bridge;
    energycharts?: Bridge;
    coinbase?: CoinbaseBridge;
}

export class MarketService {
    private readonly health = new Map<BridgeId, Health>();

    constructor(readonly catalog: Catalog, readonly bridges: Bridges) {}

    bridge(id: BridgeId): Bridge | undefined {
        return this.bridges[id] as Bridge | undefined;
    }

    resolve(symbol: string): CatalogEntry | null {
        return this.catalog.resolve(symbol);
    }

    private healthy(id: BridgeId): boolean {
        const h = this.health.get(id);
        return !h || h.openUntil < Date.now();
    }

    private record(id: BridgeId, ok: boolean): void {
        if (ok) {
            this.health.delete(id);
            return;
        }
        const h = this.health.get(id) ?? { failures: 0, openUntil: 0 };
        h.failures += 1;
        if (h.failures >= BREAKER_FAILURES) {
            h.openUntil = Date.now() + BREAKER_MS;
            h.failures = 0;
        }
        this.health.set(id, h);
    }

    status(): Record<string, { configured: boolean; healthy: boolean }> {
        const ids: BridgeId[] = ['alpaca', 'finnhub', 'yahoo', 'energycharts', 'coinbase'];
        return Object.fromEntries(ids.map((id) => [id, { configured: !!this.bridges[id], healthy: this.healthy(id) }]));
    }

    async getBars(symbol: string, tfRaw: string, req: BarRequest): Promise<{ entry: CatalogEntry; source: BridgeId; bars: OHLCV[] }> {
        const entry = this.resolve(symbol);
        if (!entry) throw new UpstreamError(`Unknown symbol ${symbol}`, 404);
        const tf = parseTimeframe(tfRaw);
        if (!tf) throw new UpstreamError(`Unsupported timeframe ${tfRaw}`, 400);
        let lastErr: unknown = null;
        let failures = 0;
        let limitedFailures = 0;
        const limited = new Map<BridgeId, number>();
        const candidates = entry.sources.filter((s) => this.bridge(s.bridge) && !avoids(s.bridge));
        if (candidates.length === 0 && entry.sources.some((s) => this.bridge(s.bridge))) throw new UpstreamError(`${entry.symbol}: its sources are reserved for users right now`, 409);
        // Prefer healthy bridges, but never give up while an untried one remains.
        const ordered = [...candidates.filter((s) => this.healthy(s.bridge)), ...candidates.filter((s) => !this.healthy(s.bridge))].filter((s) => this.bridge(s.bridge)!.supports(tf, entry));
        if (ordered.length === 0) {
            const min = entry.class === 'power' ? ' Day-ahead power prices start at 15 minutes.' : '';
            throw new UpstreamError(`${entry.symbol} is not available at the ${tfRaw} timeframe.${min}`, 400);
        }
        for (const src of ordered) {
            const bridge = this.bridge(src.bridge)!;
            try {
                let bars = await bridge.getBars(src.ticker, tf, req, entry);
                this.record(src.bridge, true);
                // An empty answer for an initial load usually means "not listed here" — try the next source.
                if (bars.length === 0 && req.from == null && ordered.length > 1 && src !== ordered[ordered.length - 1]) continue;
                if (src.bridge !== 'yahoo') bars = await this.withRealtimeExtendedTail(entry, tf, req, bars);
                return { entry, source: src.bridge, bars };
            } catch (err) {
                // Background work giving way says nothing about the source: stop here, blame no one.
                if (err instanceof BackgroundYield) throw err;
                lastErr = err;
                failures += 1;
                const wait = rateLimitWait(err);
                if (wait != null) {
                    limitedFailures += 1;
                    limited.set(src.bridge, Math.min(wait, limited.get(src.bridge) ?? Infinity));
                }
                if (!(err instanceof UpstreamError && err.status === 400)) this.record(src.bridge, false);
                if (err instanceof UpstreamError && err.status === 400) throw err;
            }
        }
        // Blame the limit only when it is what stopped every source, not one failure among others.
        if (limitedFailures > 0 && limitedFailures === failures) throw new ProviderLimitError([...limited.keys()], Math.min(...limited.values()));
        if (lastErr) throw lastErr;
        return { entry, source: ordered[0]?.bridge ?? 'yahoo', bars: [] };
    }

    /** Batched quotes for a watchlist. One upstream call per source per refresh. */
    async quotes(symbols: string[]): Promise<QuoteRow[]> {
        const byBridge = new Map<BridgeId, Array<{ entry: CatalogEntry; ticker: string; fallbacks: Array<{ bridge: BridgeId; ticker: string }> }>>();
        const entries: CatalogEntry[] = [];
        for (const s of symbols) {
            const e = this.resolve(s);
            if (!e) continue;
            entries.push(e);
            const srcs = this.quoteSources(e);
            const first = srcs.find((x) => this.healthy(x.bridge)) ?? srcs[0];
            if (!first) continue;
            const list = byBridge.get(first.bridge) ?? [];
            list.push({ entry: e, ticker: first.ticker, fallbacks: srcs.filter((x) => x !== first) });
            byBridge.set(first.bridge, list);
        }
        const rows = new Map<string, QuoteRow>();
        const raw = new Map<string, Quote>();
        const misses: Array<{ entry: CatalogEntry; fallbacks: Array<{ bridge: BridgeId; ticker: string }> }> = [];
        await Promise.all(
            [...byBridge].map(async ([id, items]) => {
                const bridge = this.bridge(id);
                try {
                    const got = (await bridge?.quotes?.(items.map((i) => i.ticker), items.map((i) => i.entry))) ?? new Map<string, Quote>();
                    this.record(id, true);
                    for (const it of items) {
                        const q = got.get(it.ticker);
                        if (q) {
                            rows.set(it.entry.symbol, this.row(it.entry, q, id));
                            raw.set(it.entry.symbol, q);
                        }
                        else misses.push(it);
                    }
                } catch (err) {
                    if (err instanceof BackgroundYield) throw err;
                    this.record(id, false);
                    misses.push(...items);
                }
            }),
        );
        // Second chance, one at a time, on the next source.
        await Promise.all(
            misses.map(async (m) => {
                for (const fb of m.fallbacks) {
                    const q = await this.bridge(fb.bridge)?.quotes?.([fb.ticker], [m.entry]).catch(() => null);
                    const hit = q?.get(fb.ticker);
                    if (hit) {
                        rows.set(m.entry.symbol, this.row(m.entry, hit, fb.bridge));
                        raw.set(m.entry.symbol, hit);
                        return;
                    }
                }
            }),
        );
        // Real-time trades beat snapshot prices.
        for (const e of entries) {
            const live = e.live && this.bridges.finnhub?.lastTrade(e.live.ticker);
            const r = rows.get(e.symbol);
            if (live && r && live.time > r.time && this.tradeCountsForQuote(e, live)) rows.set(e.symbol, this.row(e, { price: live.price, prevClose: r.prevClose, time: live.time }, r.source));
        }
        await this.attachExtended(entries, rows, raw);
        return symbols.map((s) => this.resolve(s)?.symbol).flatMap((s) => (s && rows.get(s) ? [rows.get(s)!] : []));
    }

    /**
     * The extended-hours tape of a US equity is delayed on the consolidated feed and absent
     * from the real-time single-venue one, so outside regular hours its newest minutes come
     * from Yahoo's real-time tape instead. Any Yahoo failure (its budget included) keeps the
     * delayed answer.
     */
    private async withRealtimeExtendedTail(entry: CatalogEntry, tf: Timeframe, req: BarRequest, bars: OHLCV[]): Promise<OHLCV[]> {
        if (req.session !== 'extended' || (entry.class !== 'stock' && entry.class !== 'etf') || tf.unit !== 'minute' || tf.n >= 1440) return bars;
        const now = Date.now();
        const tailMs = Math.max(EXTENDED_TAIL_MS, 2 * tf.n * 60_000);
        if (req.to != null && req.to < now - tailMs) return bars;
        const yahoo = this.bridges.yahoo;
        const src = entry.sources.find((x) => x.bridge === 'yahoo');
        if (!yahoo || !src || !this.healthy('yahoo') || avoids('yahoo')) return bars;
        if (await this.regularSessionOpen(entry, now)) return bars;
        try {
            const tail = await yahoo.getBars(src.ticker, tf, { from: now - tailMs, session: 'extended' }, entry);
            this.record('yahoo', true);
            return clip(spliceTail(bars, tail), { from: req.from, to: req.to, limit: req.limit });
        } catch (err) {
            if (!(err instanceof BackgroundYield)) this.record('yahoo', false);
            return bars;
        }
    }

    /** Whether US equities trade their regular session at `now`, per the exchange calendar. */
    async usRegularOpen(now: number): Promise<boolean> {
        const days = await this.bridges.alpaca?.calendar(now - 86_400_000, now + 86_400_000).catch(() => null);
        if (days) return [...days.values()].some((d) => now >= d.open && now < d.close);
        const [y, m, d] = localDate('America/New_York', now).split('-').map(Number) as [number, number, number];
        const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        const tod = localTimeOfDay('America/New_York', now);
        return wd !== 0 && wd !== 6 && tod >= 9.5 * 3_600_000 && tod < 16 * 3_600_000;
    }

    /** Whether the US equity session is in regular hours at `now`, per the exchange calendar. */
    private async regularSessionOpen(entry: CatalogEntry, now: number): Promise<boolean> {
        const windows = await this.calendar(entry.symbol, now - 60_000, now + 60_000, 'regular').catch(() => null);
        if (windows) return windows.some(([a, b]) => now >= a && now < b);
        const tod = localTimeOfDay('America/New_York', now);
        return tod >= 9.5 * 3_600_000 && tod < 16 * 3_600_000;
    }

    /** Pre/post-market prices for the equity rows, while the regular session is closed: the
     *  real-time Yahoo price when its budget allows, else the delayed consolidated one. */
    private async attachExtended(entries: CatalogEntry[], rows: Map<string, QuoteRow>, quotes: Map<string, Quote>): Promise<void> {
        const equities = entries.filter((e) => (e.class === 'stock' || e.class === 'etf') && rows.has(e.symbol));
        if (equities.length === 0 || (await this.regularSessionOpen(equities[0]!, Date.now()))) return;
        const yahooTicker = (e: CatalogEntry) => e.sources.find((x) => x.bridge === 'yahoo')?.ticker;
        let live = new Map<string, ExtendedQuote>();
        const yahoo = this.bridges.yahoo;
        if (yahoo?.extendedQuotes && this.healthy('yahoo') && !avoids('yahoo')) {
            const tickers = equities.map(yahooTicker).filter((t): t is string => !!t);
            live = await yahoo.extendedQuotes(tickers).catch(() => new Map<string, ExtendedQuote>());
        }
        for (const e of equities) {
            const yt = yahooTicker(e);
            const candidates = [yt ? live.get(yt) : undefined, quotes.get(e.symbol)?.extended].filter((x): x is ExtendedQuote => !!x);
            const newest = candidates.sort((a, b) => b.time - a.time)[0];
            const row = rows.get(e.symbol)!;
            if (!newest) continue;
            const change = newest.base != null ? newest.price - newest.base : null;
            row.extended = { session: newest.session, price: newest.price, change, changePct: change != null && newest.base ? (change / newest.base) * 100 : null, time: newest.time };
        }
    }

    private quoteSources(e: CatalogEntry): Array<{ bridge: BridgeId; ticker: string }> {
        const out: Array<{ bridge: BridgeId; ticker: string }> = [];
        for (const s of e.sources) if (this.bridge(s.bridge)?.quotes) out.push(s);
        if ((e.class === 'stock' || e.class === 'etf') && this.bridges.finnhub) out.push({ bridge: 'finnhub', ticker: e.symbol });
        return out.filter((s) => !avoids(s.bridge));
    }

    /** Equity trades after the close would move "today's" change — only regular hours count. */
    private tradeCountsForQuote(e: CatalogEntry, t: Trade): boolean {
        if (e.class !== 'stock' && e.class !== 'etf') return true;
        const tod = localTimeOfDay('America/New_York', t.time);
        return tod >= 9.5 * 3_600_000 && tod < 16 * 3_600_000;
    }

    private row(e: CatalogEntry, q: Quote, source: BridgeId): QuoteRow {
        const change = q.prevClose != null ? q.price - q.prevClose : null;
        return {
            symbol: e.symbol,
            price: q.price,
            prevClose: q.prevClose,
            change,
            changePct: change != null && q.prevClose ? (change / q.prevClose) * 100 : null,
            time: q.time,
            source,
        };
    }

    /**
     * Open-market windows for the market-status badge. US-calendar instruments use the
     * exchange calendar (holidays, half days); other sessioned venues get their session
     * on weekdays (holidays not modelled). Null for continuous markets.
     */
    async calendar(symbol: string, from: number, to: number, session: string): Promise<Array<[number, number]> | null> {
        const e = this.resolve(symbol);
        if (!e) return null;
        if (this.bridges.alpaca && this.catalog.followsUsCalendar(e)) {
            const days = await this.bridges.alpaca.calendar(from - 86_400_000, to + 86_400_000);
            const out: Array<[number, number]> = [];
            for (const d of [...days.values()].sort((a, b) => a.open - b.open)) {
                const w: [number, number] = session === 'extended' && (e.class === 'stock' || e.class === 'etf') ? [d.sessionOpen, d.sessionClose] : [d.open, d.close];
                if (w[1] > from && w[0] < to) out.push(w);
            }
            return out;
        }
        return weekdayWindows(e, from, to);
    }
}

/**
 * Lay a real-time tail over delayed bars: the tail takes over from the delayed tape's newest
 * bar (often a partial bucket) onward; older delayed bars stand.
 */
export function spliceTail(bars: readonly OHLCV[], tail: readonly OHLCV[]): OHLCV[] {
    if (tail.length === 0) return [...bars];
    const cut = bars.length > 0 ? bars[bars.length - 1]!.time : -Infinity;
    const fresh = tail.filter((b) => b.time >= cut);
    if (fresh.length === 0) return [...bars];
    const replaced = new Set(fresh.map((b) => b.time));
    return [...bars.filter((b) => !replaced.has(b.time)), ...fresh].sort((a, b) => a.time - b.time);
}

/** Mon–Fri windows of `entry.session` (`HHMM-HHMM`) in its own zone. */
export function weekdayWindows(entry: CatalogEntry, from: number, to: number): Array<[number, number]> | null {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(entry.session);
    if (!m) return null;
    const open = (Number(m[1]) * 60 + Number(m[2])) * 60_000;
    const close = (Number(m[3]) * 60 + Number(m[4])) * 60_000;
    const out: Array<[number, number]> = [];
    for (let t = from - 86_400_000; t < to + 86_400_000; t += 86_400_000) {
        const [y, mo, d] = localDate(entry.timezone, t).split('-').map(Number) as [number, number, number];
        const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
        if (wd === 0 || wd === 6) continue;
        const w: [number, number] = [zonedWallTime(entry.timezone, y, mo - 1, d, open), zonedWallTime(entry.timezone, y, mo - 1, d, close)];
        if (w[1] > from && w[0] < to && (out.length === 0 || out[out.length - 1]![0] !== w[0])) out.push(w);
    }
    return out;
}

/** Whether a trade at `t` belongs to the bar opened at `barTime` for `tf`. */
export function tradeInBar(tf: Timeframe, barTime: number, t: number, timeZone: string, anchorMs = 0): boolean {
    return bucketStart(tf, t, timeZone, anchorMs) === barTime;
}
