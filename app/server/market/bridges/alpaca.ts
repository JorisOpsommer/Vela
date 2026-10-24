// Alpaca market data (Basic plan): US equities and US crypto. History comes from the
// consolidated SIP tape, which the free plan serves up to 15 minutes ago; the newest
// stretch is filled from the real-time IEX feed. The trading API supplies the asset list
// (search) and the exchange calendar (sessions, holidays, half days).
import type { Bridge, BarRequest, CatalogEntry, ExtendedQuote, OHLCV, Quote } from '../types';
import { TokenBucket, TtlCache, fetchJson } from '../limits';
import { aggregate, clip, localDate, localTimeOfDay, nominalMs, normalizeBars, zonedWallTime, type Timeframe } from '../timeframes';

export interface AlpacaConfig {
    keyId: string;
    secret: string;
    dataUrl: string;
    tradingUrl: string;
}

interface RawBar {
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
}

interface BarsPage {
    bars: Record<string, RawBar[] | undefined> | null;
    next_page_token: string | null;
}

export interface RawSnapshot {
    latestTrade?: { p: number; t: string };
    dailyBar?: RawBar;
    prevDailyBar?: RawBar;
    minuteBar?: RawBar;
}

export interface AlpacaAsset {
    symbol: string;
    name: string;
    exchange: string;
    class: string;
    status: string;
    tradable: boolean;
    marginable?: boolean;
    /** Percent of the position's value, as the broker sets them (decimal strings or numbers). */
    maintenance_margin_requirement?: number | string;
    margin_requirement_long?: number | string;
    margin_requirement_short?: number | string;
    shortable?: boolean;
    easy_to_borrow?: boolean;
    /** Flags such as `has_options`. */
    attributes?: string[];
}

/** One listed option contract, with its open interest as of `open_interest_date`. */
export interface RawOptionContract {
    symbol: string;
    type: 'call' | 'put';
    expiration_date: string;
    strike_price: string;
    multiplier?: string;
    open_interest?: string | null;
    open_interest_date?: string | null;
    close_price?: string | null;
}

/** An option snapshot on the indicative feed: derived quotes, delayed trades, model greeks. */
export interface RawOptionSnapshot {
    latestQuote?: { bp: number; ap: number; t: string };
    latestTrade?: { p: number; t: string };
    dailyBar?: RawBar;
    greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number };
    impliedVolatility?: number;
}

export interface OptionWindow {
    /** Contracts expiring on or before this date (`YYYY-MM-DD`, New York). */
    expiresBy: string;
    /** Snapshots only: the strike range worth quoting. */
    strikeMin?: number;
    strikeMax?: number;
    /** Snapshots only: expiring on or before this date (narrower than the contracts'). */
    quotedBy?: string;
}

export interface CalendarDay {
    /** Regular session [open, close) and extended [sessionOpen, sessionClose), epoch ms. */
    open: number;
    close: number;
    sessionOpen: number;
    sessionClose: number;
}

const NY = 'America/New_York';
const SIP_DELAY_MS = 15 * 60_000;
/** Overlap between the SIP history and the IEX tail, so the partial SIP bucket is merged. */
const TAIL_WINDOW_MS = 20 * 60_000;
const MAX_PAGES = 12;
/** A chain longer than this many pages is cut short (the largest index chains run ~15). */
const MAX_OPTION_PAGES = 20;
const DAY_MS = 86_400_000;
/** Intraday history is fetched in fixed windows of about one page each (a page holds
 *  roughly ten thousand minutes of tape, whatever the bar size). */
const WINDOW_MS = 14 * DAY_MS;
const CRYPTO_WINDOW_MS = 7 * DAY_MS;
/** About eight months: a 1000-bar hourly chart fits; coarser ones get what reaches. */
const MAX_WINDOWS = 18;
const WINDOW_CONCURRENCY = 4;

function toBar(r: RawBar): OHLCV {
    return { time: Date.parse(r.t), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v };
}

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}

/** Alpaca timeframe string for a NATIVE request, or null when it must be aggregated. */
export function alpacaTimeframe(tf: Timeframe): string | null {
    if (tf.unit === 'minute') {
        if (tf.n < 60) return `${tf.n}Min`;
        if (tf.n % 60 === 0 && tf.n / 60 < 24) return `${tf.n / 60}Hour`;
        if (tf.n === 1440) return '1Day';
        return null;
    }
    if (tf.unit === 'day') return tf.n === 1 ? '1Day' : null;
    if (tf.unit === 'week') return tf.n === 1 ? '1Week' : null;
    return [1, 2, 3, 4, 6, 12].includes(tf.n) ? `${tf.n}Month` : null;
}

/** Wall-clock `HH:MM` in New York → ms after local midnight. */
function hhmm(s: string): number {
    const m = /^(\d{2}):?(\d{2})$/.exec(s);
    return m ? (Number(m[1]) * 60 + Number(m[2])) * 60_000 : 0;
}

/**
 * The timeframe to request from Alpaca for `tf`, and the session anchor to fold it with.
 * Native bars are used only when their clock alignment matches the chart's: regular-hours
 * equity bars start at the 09:30 open, extended-hours ones at 04:00.
 */
export function planBase(tf: Timeframe, crypto: boolean, regular: boolean): { base: Timeframe; anchorMs: number } {
    if (tf.unit === 'minute' && tf.n < 1440) {
        if (crypto) {
            return alpacaTimeframe(tf) && (tf.n < 60 ? 60 % tf.n === 0 : 1440 % tf.n === 0) ? { base: tf, anchorMs: 0 } : { base: { unit: 'minute', n: gcd(tf.n, 60) }, anchorMs: 0 };
        }
        if (regular) return 30 % tf.n === 0 ? { base: tf, anchorMs: 0 } : { base: { unit: 'minute', n: gcd(tf.n, 30) }, anchorMs: hhmm('09:30') };
        const native = tf.n < 60 ? 60 % tf.n === 0 : tf.n === 60;
        return native ? { base: tf, anchorMs: 0 } : { base: { unit: 'minute', n: gcd(tf.n, 60) }, anchorMs: hhmm('04:00') };
    }
    if (alpacaTimeframe(tf)) return { base: tf, anchorMs: 0 };
    const unit = tf.unit === 'minute' ? 'day' : tf.unit;
    return { base: { unit, n: 1 }, anchorMs: 0 };
}

/** Merge the IEX tail onto SIP history bar by bar: SIP keeps the open and its volume,
 *  the newer IEX trades extend the range and set the close. */
export function mergeTail(history: OHLCV[], tail: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of history) byTime.set(b.time, { ...b });
    for (const t of tail) {
        const h = byTime.get(t.time);
        if (!h) byTime.set(t.time, { ...t });
        else byTime.set(t.time, { time: t.time, open: h.open, high: Math.max(h.high, t.high), low: Math.min(h.low, t.low), close: t.close, volume: Math.max(h.volume ?? 0, t.volume ?? 0) });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export class AlpacaBridge implements Bridge {
    readonly id = 'alpaca' as const;
    readonly pollMs = 15_000;
    private readonly bucket = new TokenBucket(180, 30, 'alpaca');
    private readonly barCache = new TtlCache<OHLCV[]>(1_000, 'alpaca');
    private readonly quoteCache = new TtlCache<Map<string, Quote>>(50, 'alpaca');
    private readonly calendarCache = new TtlCache<Map<string, CalendarDay>>(20, 'alpaca');
    private assetsPromise: Promise<AlpacaAsset[]> | null = null;

    constructor(private readonly cfg: AlpacaConfig) {}

    private headers(): Record<string, string> {
        return { 'APCA-API-KEY-ID': this.cfg.keyId, 'APCA-API-SECRET-KEY': this.cfg.secret };
    }

    private async get<T>(url: string, tag: string): Promise<T> {
        await this.bucket.take();
        return fetchJson<T>(url, { headers: this.headers(), bridge: 'alpaca', tag });
    }

    supports(_tf: Timeframe, entry: CatalogEntry): boolean {
        return entry.class === 'stock' || entry.class === 'etf' || entry.class === 'crypto';
    }

    async getBars(ticker: string, tf: Timeframe, req: BarRequest, entry: CatalogEntry): Promise<OHLCV[]> {
        const crypto = entry.class === 'crypto';
        const regular = !crypto && req.session !== 'extended';
        const now = Date.now();
        const to = Math.min(req.to ?? now, now);
        const from = req.from ?? to - this.lookbackMs(tf, req.limit ?? 500, crypto, regular);

        const { base, anchorMs } = planBase(tf, crypto, regular);
        const baseTf = alpacaTimeframe(base)!;

        let bars: OHLCV[];
        if (crypto) {
            bars = await this.fetchHistory('crypto', ticker, base, baseTf, from, to);
        } else {
            const sipEnd = Math.min(to, now - SIP_DELAY_MS);
            const history = sipEnd > from ? await this.fetchHistory('sip', ticker, base, baseTf, from, sipEnd) : [];
            // IEX refines only the bars SIP has not closed yet; a finished bar keeps its consolidated close.
            const tail = to > now - SIP_DELAY_MS - 60_000 ? (await this.fetchTail(ticker, base, baseTf, now)).filter((b) => b.time + nominalMs(base) > sipEnd) : [];
            bars = mergeTail(history, tail);
            if (base.unit === 'minute') bars = await this.filterSession(bars, regular, from, to);
        }
        if (base !== tf) bars = aggregate(bars, tf, crypto ? 'Etc/UTC' : NY, anchorMs);
        return clip(normalizeBars(bars), { from: req.from, to: req.to, limit: req.limit });
    }

    private lookbackMs(tf: Timeframe, limit: number, crypto: boolean, regular: boolean): number {
        const span = nominalMs(tf) * limit;
        if (crypto) return span * 1.05;
        if (tf.unit !== 'minute' || tf.n >= 1440) return span * 1.5 + 10 * DAY_MS;
        // Only part of each day trades: 6.5 h regular / 16 h extended, five days a week.
        const hours = regular ? 6.5 : 16;
        return span * (24 / hours) * (7 / 5) * 1.2 + 4 * DAY_MS;
    }

    /** IEX bars for the newest window (SIP would refuse it). Shared across charts. */
    private fetchTail(ticker: string, base: Timeframe, baseTf: string, now: number): Promise<OHLCV[]> {
        const windowMs = Math.max(TAIL_WINDOW_MS, nominalMs(base) * 2);
        const from = Math.floor((now - windowMs) / 60_000) * 60_000;
        const key = `tail|${ticker}|${baseTf}`;
        return this.barCache.wrap(key, 5_000, () => this.fetchRange('iex', ticker, baseTf, from, now));
    }

    /**
     * Intraday history in fixed windows aligned to the epoch, newest first: one long
     * ascending walk runs out of pages at the NEW end and leaves a hole before the tail.
     * Past windows never change, so a repeat load re-fetches only the newest one.
     */
    private async fetchHistory(feed: 'sip' | 'crypto', ticker: string, base: Timeframe, baseTf: string, from: number, to: number): Promise<OHLCV[]> {
        if (base.unit !== 'minute' || base.n >= 1440) return this.fetchRange(feed, ticker, baseTf, from, to);
        const span = feed === 'crypto' ? CRYPTO_WINDOW_MS : WINDOW_MS;
        const windows: Array<[number, number]> = [];
        for (let start = Math.floor((to - 1) / span) * span, end = to; end > from && windows.length < MAX_WINDOWS; end = start, start -= span) windows.push([start, end]);
        const parts: OHLCV[][] = new Array(windows.length);
        let next = 0;
        const worker = async () => {
            while (next < windows.length) {
                const i = next++;
                parts[i] = await this.fetchRange(feed, ticker, baseTf, windows[i]![0], windows[i]![1]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(WINDOW_CONCURRENCY, windows.length) }, worker));
        // Windows share their edges: a bar on one appears in both.
        const byTime = new Map<number, OHLCV>();
        for (const part of parts.reverse()) for (const b of part) byTime.set(b.time, b);
        return [...byTime.values()].sort((a, b) => a.time - b.time);
    }

    private async fetchRange(feed: 'sip' | 'iex' | 'crypto', ticker: string, timeframe: string, from: number, to: number): Promise<OHLCV[]> {
        // History older than a few minutes never changes: cache it by minute-rounded range.
        const roundedTo = Math.floor(to / 60_000) * 60_000;
        const key = `${feed}|${ticker}|${timeframe}|${Math.floor(from / 60_000)}|${roundedTo}`;
        return this.barCache.wrap(key, to < Date.now() - DAY_MS ? 6 * 3_600_000 : 30_000, async () => {
            const out: OHLCV[] = [];
            let page: string | null = null;
            for (let i = 0; i < MAX_PAGES; i++) {
                const q = new URLSearchParams({ symbols: ticker, timeframe, start: new Date(from).toISOString(), limit: '10000', sort: 'asc' });
                if (feed === 'crypto') {
                    q.set('end', new Date(to).toISOString());
                } else {
                    q.set('feed', feed);
                    q.set('adjustment', 'split');
                    // SIP: omit `end` near the present — the API clamps itself to its delay.
                    if (feed === 'iex' || to < Date.now() - SIP_DELAY_MS - 60_000) q.set('end', new Date(to).toISOString());
                }
                if (page) q.set('page_token', page);
                const url = feed === 'crypto' ? `${this.cfg.dataUrl}/v1beta3/crypto/us/bars?${q}` : `${this.cfg.dataUrl}/v2/stocks/bars?${q}`;
                const res = await this.get<BarsPage>(url, `bars:${feed}`);
                for (const r of res.bars?.[ticker] ?? []) out.push(toBar(r));
                page = res.next_page_token;
                if (!page) break;
            }
            return out;
        });
    }

    /** Keep intraday bars inside the session the chart shows, per the exchange calendar. */
    private async filterSession(bars: OHLCV[], regular: boolean, from: number, to: number): Promise<OHLCV[]> {
        if (bars.length === 0) return bars;
        const cal = await this.calendar(Math.min(from, bars[0]!.time), Math.max(to, bars[bars.length - 1]!.time)).catch(() => null);
        return bars.filter((b) => {
            const day = cal?.get(localDate(NY, b.time));
            if (cal && !day) return false;
            if (!day) {
                const tod = localTimeOfDay(NY, b.time);
                return regular ? tod >= hhmm('09:30') && tod < hhmm('16:00') : tod >= hhmm('04:00') && tod < hhmm('20:00');
            }
            return regular ? b.time >= day.open && b.time < day.close : b.time >= day.sessionOpen && b.time < day.sessionClose;
        });
    }

    /** Trading days in [from, to], keyed `YYYY-MM-DD` (New York). */
    async calendar(from: number, to: number): Promise<Map<string, CalendarDay>> {
        const years: number[] = [];
        for (let y = new Date(from).getUTCFullYear(); y <= new Date(to).getUTCFullYear(); y++) years.push(y);
        const out = new Map<string, CalendarDay>();
        for (const y of years) {
            const yearMap = await this.calendarCache.wrap(String(y), 24 * 3_600_000, async () => {
                const rows = await this.get<Array<{ date: string; open: string; close: string; session_open: string; session_close: string }>>(
                    `${this.cfg.tradingUrl}/calendar?start=${y}-01-01&end=${y}-12-31`,
                    'calendar',
                );
                const m = new Map<string, CalendarDay>();
                for (const r of rows) {
                    const [yy, mm, dd] = r.date.split('-').map(Number) as [number, number, number];
                    const at = (s: string) => zonedWallTime(NY, yy, mm - 1, dd, hhmm(s));
                    m.set(r.date, { open: at(r.open), close: at(r.close), sessionOpen: at(r.session_open), sessionClose: at(r.session_close) });
                }
                return m;
            });
            for (const [k, v] of yearMap) out.set(k, v);
        }
        return out;
    }

    async quotes(tickers: string[], entries: CatalogEntry[]): Promise<Map<string, Quote>> {
        const stocks = tickers.filter((_, i) => entries[i]!.class !== 'crypto');
        const crypto = tickers.filter((_, i) => entries[i]!.class === 'crypto');
        const out = new Map<string, Quote>();
        const jobs: Promise<Map<string, Quote>>[] = [];
        if (stocks.length) {
            const list = encodeURIComponent(stocks.join(','));
            jobs.push(
                this.quoteCache.wrap(`s|${[...stocks].sort().join(',')}`, 10_000, async () => {
                    // IEX is real time but only one venue, with no extended-hours trades; the
                    // consolidated (delayed) tape carries the official closes and the pre/post
                    // trades. A failed consolidated read keeps the IEX answer.
                    const [iex, sip] = await Promise.all([
                        this.get<Record<string, RawSnapshot>>(`${this.cfg.dataUrl}/v2/stocks/snapshots?symbols=${list}&feed=iex`, 'snapshots'),
                        this.get<Record<string, RawSnapshot>>(`${this.cfg.dataUrl}/v2/stocks/snapshots?symbols=${list}&feed=delayed_sip`, 'snapshots-sip').catch(() => null),
                    ]);
                    const out = parseSnapshots(iex);
                    if (!sip) return out;
                    const cal = await this.calendar(Date.now() - 10 * DAY_MS, Date.now()).catch(() => null);
                    for (const [sym, q] of out) {
                        const s = sip[sym];
                        if (!s) continue;
                        const prevClose = s.prevDailyBar?.c ?? q.prevClose;
                        const extended = cal ? extendedFromSnapshot(s, cal) : null;
                        out.set(sym, { ...q, prevClose, ...(extended ? { extended } : {}) });
                    }
                    return out;
                }),
            );
        }
        if (crypto.length) {
            jobs.push(
                this.quoteCache.wrap(`c|${[...crypto].sort().join(',')}`, 10_000, async () =>
                    parseSnapshots((await this.get<{ snapshots?: Record<string, RawSnapshot> }>(`${this.cfg.dataUrl}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(crypto.join(','))}`, 'crypto-snapshots')).snapshots ?? {}),
                ),
            );
        }
        for (const m of await Promise.all(jobs)) for (const [k, v] of m) out.set(k, v);
        return out;
    }

    /** Every active, tradable US equity (≈ 10k rows) — powers symbol search. */
    assets(): Promise<AlpacaAsset[]> {
        if (!this.assetsPromise) {
            this.assetsPromise = this.get<AlpacaAsset[]>(`${this.cfg.tradingUrl}/assets?status=active&asset_class=us_equity`, 'assets')
                .then((rows) => rows.filter((a) => a.tradable && a.status === 'active' && a.exchange !== 'OTC'))
                .catch((err: unknown) => {
                    this.assetsPromise = null;
                    throw err;
                });
            // Refresh daily: listings change.
            setTimeout(() => (this.assetsPromise = null), 24 * 3_600_000).unref?.();
        }
        return this.assetsPromise;
    }

    /** Every active contract on `underlying` expiring by `w.expiresBy`, open interest included. */
    async optionContracts(underlying: string, w: OptionWindow): Promise<RawOptionContract[]> {
        const out: RawOptionContract[] = [];
        let token: string | null = null;
        for (let page = 0; page < MAX_OPTION_PAGES; page++) {
            const url = `${this.cfg.tradingUrl}/options/contracts?underlying_symbols=${encodeURIComponent(underlying)}&status=active&expiration_date_lte=${w.expiresBy}&limit=10000${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
            const res: { option_contracts?: RawOptionContract[]; next_page_token?: string | null } = await this.get(url, 'option-contracts');
            out.push(...(res.option_contracts ?? []));
            token = res.next_page_token ?? null;
            if (!token) break;
        }
        return out;
    }

    /** Snapshots (quotes, greeks, implied volatility) of `underlying`'s contracts inside the window, by contract symbol. */
    async optionSnapshots(underlying: string, w: OptionWindow): Promise<Map<string, RawOptionSnapshot>> {
        const out = new Map<string, RawOptionSnapshot>();
        const range = `${w.strikeMin != null ? `&strike_price_gte=${w.strikeMin}` : ''}${w.strikeMax != null ? `&strike_price_lte=${w.strikeMax}` : ''}`;
        let token: string | null = null;
        for (let page = 0; page < MAX_OPTION_PAGES; page++) {
            const url = `${this.cfg.dataUrl}/v1beta1/options/snapshots/${encodeURIComponent(underlying)}?feed=indicative&limit=1000&expiration_date_lte=${w.quotedBy ?? w.expiresBy}${range}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
            const res: { snapshots?: Record<string, RawOptionSnapshot>; next_page_token?: string | null } = await this.get(url, 'option-snapshots');
            for (const [k, v] of Object.entries(res.snapshots ?? {})) out.set(k, v);
            token = res.next_page_token ?? null;
            if (!token) break;
        }
        return out;
    }

    budgetLeft(): number {
        return this.bucket.available();
    }
}

/**
 * A consolidated snapshot's latest trade, when it fell in the pre- or post-market of its
 * trading day: measured from that day's regular close after hours, and from the previous
 * trading day's before the open. Daily bars cover the regular session only.
 */
export function extendedFromSnapshot(s: RawSnapshot, cal: ReadonlyMap<string, CalendarDay>): ExtendedQuote | null {
    if (!s.latestTrade) return null;
    const t = Date.parse(s.latestTrade.t);
    const date = localDate(NY, t);
    const day = cal.get(date);
    if (!day || (t >= day.open && t < day.close) || t < day.sessionOpen || t >= day.sessionClose) return null;
    const daily = [s.dailyBar, s.prevDailyBar].filter((b): b is RawBar => !!b).map((b) => ({ date: localDate(NY, Date.parse(b.t)), close: b.c }));
    if (t < day.open) {
        const prior = daily.filter((b) => b.date < date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
        return { session: 'pre', price: s.latestTrade.p, base: prior?.close ?? null, time: t };
    }
    return { session: 'post', price: s.latestTrade.p, base: daily.find((b) => b.date === date)?.close ?? null, time: t };
}

/** Snapshot rows → quotes. The previous daily bar holds the prior session's close. */
export function parseSnapshots(snaps: Record<string, RawSnapshot>): Map<string, Quote> {
    const out = new Map<string, Quote>();
    for (const [sym, s] of Object.entries(snaps)) {
        const price = s.latestTrade?.p ?? s.minuteBar?.c ?? s.dailyBar?.c;
        if (price == null) continue;
        out.set(sym, { price, prevClose: s.prevDailyBar?.c ?? null, time: s.latestTrade ? Date.parse(s.latestTrade.t) : Date.now() });
    }
    return out;
}
