// Yahoo Finance's public chart endpoint (no key): indices, futures, FX, and a fallback
// for equities. Unofficial — it can change without notice — so every answer is cached and
// the request rate is kept low.
import type { Bridge, BarRequest, CatalogEntry, ExtendedQuote, OHLCV, Quote } from '../types';
import { UpstreamError } from '../types';
import { TokenBucket, TtlCache, fetchJson } from '../limits';
import { aggregate, clip, localDate, localMidnight, localTimeOfDay, nominalMs, normalizeBars, type Timeframe } from '../timeframes';

interface ChartResponse {
    chart: {
        result: Array<{
            meta: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                regularMarketTime?: number;
                exchangeTimezoneName?: string;
                tradingPeriods?: { pre?: TradingPeriod[][]; regular?: TradingPeriod[][]; post?: TradingPeriod[][] } | TradingPeriod[][];
            };
            timestamp?: number[];
            indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> };
        }> | null;
        error: { code: string; description: string } | null;
    };
}

interface TradingPeriod {
    start: number;
    end: number;
}

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
// A full browser UA string without browser cookies is throttled; the bare token is not.
const UA = 'Mozilla/5.0';
const DAY_MS = 86_400_000;
/** Extended-hours intraday bars fold from the 04:00 New York tape open. */
const EXTENDED_ANCHOR_MS = 4 * 3_600_000;
/** An extended quote younger than this is not fetched again. */
const EXT_FRESH_MS = 60_000;
/** An extended quote older than this is not served (the caller falls back). */
const EXT_MAX_AGE_MS = 5 * 60_000;
/** Tokens the extended quotes leave in the bucket for chart loads. */
const EXT_RESERVE = 4;

/** Yahoo intraday intervals (minutes) and how far back each is served. */
const INTRADAY: Array<{ n: number; interval: string; maxAgeMs: number; maxSpanMs: number }> = [
    { n: 60, interval: '60m', maxAgeMs: 729 * DAY_MS, maxSpanMs: 729 * DAY_MS },
    { n: 30, interval: '30m', maxAgeMs: 59 * DAY_MS, maxSpanMs: 59 * DAY_MS },
    { n: 15, interval: '15m', maxAgeMs: 59 * DAY_MS, maxSpanMs: 59 * DAY_MS },
    { n: 5, interval: '5m', maxAgeMs: 59 * DAY_MS, maxSpanMs: 59 * DAY_MS },
    { n: 2, interval: '2m', maxAgeMs: 59 * DAY_MS, maxSpanMs: 59 * DAY_MS },
    { n: 1, interval: '1m', maxAgeMs: 29 * DAY_MS, maxSpanMs: 7 * DAY_MS },
];

interface Plan {
    interval: string;
    base: Timeframe;
    maxAgeMs: number;
    maxSpanMs: number;
}

/** The Yahoo interval to fetch for `tf` (largest that divides it). */
export function yahooPlan(tf: Timeframe): Plan {
    if (tf.unit === 'minute' && tf.n < 1440) {
        const hit = INTRADAY.find((i) => tf.n % i.n === 0) ?? INTRADAY[INTRADAY.length - 1]!;
        return { interval: hit.interval, base: { unit: 'minute', n: hit.n }, maxAgeMs: hit.maxAgeMs, maxSpanMs: hit.maxSpanMs };
    }
    if (tf.unit === 'week' && tf.n === 1) return { interval: '1wk', base: tf, maxAgeMs: Infinity, maxSpanMs: Infinity };
    if (tf.unit === 'month') return { interval: '1mo', base: { unit: 'month', n: 1 }, maxAgeMs: Infinity, maxSpanMs: Infinity };
    return { interval: '1d', base: { unit: 'day', n: 1 }, maxAgeMs: Infinity, maxSpanMs: Infinity };
}

/**
 * The time of day the venue's sessions usually start — the most common time of day of each
 * local day's FIRST bar (09:30 for a US index, midnight for a near-24h future). Aggregated
 * intraday bars anchor on it, so a 4h index bar covers 09:30–13:30, not 08:00–12:00.
 */
export function sessionOpenOfDay(bars: readonly OHLCV[], tz: string): number {
    const firsts = new Map<string, number>();
    for (const b of bars) {
        const d = localDate(tz, b.time);
        if (!firsts.has(d)) firsts.set(d, localTimeOfDay(tz, b.time));
    }
    const counts = new Map<number, number>();
    for (const tod of firsts.values()) counts.set(tod, (counts.get(tod) ?? 0) + 1);
    let best = 0;
    let bestN = 0;
    for (const [tod, n] of counts) if (n > bestN) [best, bestN] = [tod, n];
    return best;
}

export class YahooBridge implements Bridge {
    readonly id = 'yahoo' as const;
    readonly pollMs = 60_000;
    private readonly bucket = new TokenBucket(40, 8, 'yahoo');
    private readonly chunkCache = new TtlCache<{ tz: string | null; bars: OHLCV[] }>(600, 'yahoo');
    private readonly quoteCache = new TtlCache<Quote | null>(300, 'yahoo');
    private readonly extCache = new Map<string, { value: ExtendedQuote | null; at: number }>();

    supports(_tf: Timeframe, _entry: CatalogEntry): boolean {
        return true;
    }

    private async chart(ticker: string, params: Record<string, string>): Promise<ChartResponse['chart']['result'] & object> {
        await this.bucket.take();
        const q = new URLSearchParams({ includePrePost: 'false', events: 'div,split', ...params });
        let lastErr: unknown;
        for (const host of HOSTS) {
            try {
                const res = await fetchJson<ChartResponse>(`${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${q}`, { headers: { 'User-Agent': UA }, retries: 1, bridge: 'yahoo', tag: `chart:${params.interval ?? '?'}` });
                if (res.chart.error || !res.chart.result) throw new UpstreamError(res.chart.error?.description ?? 'no data', 404);
                return res.chart.result;
            } catch (err) {
                lastErr = err;
                if (err instanceof UpstreamError && err.status === 404) throw err;
            }
        }
        throw lastErr;
    }

    async getBars(ticker: string, tf: Timeframe, req: BarRequest, entry: CatalogEntry): Promise<OHLCV[]> {
        const plan = yahooPlan(tf);
        const now = Date.now();
        const to = Math.min(req.to ?? now, now);
        const extended = req.session === 'extended' && (entry.class === 'stock' || entry.class === 'etf') && plan.base.unit === 'minute';
        const sessionHours = entry.class === 'futures' || entry.class === 'forex' ? 23 : extended ? 16 : 7;
        const intradayFactor = plan.base.unit === 'minute' ? (24 / sessionHours) * (7 / 5) * 1.2 : 1.5;
        let from = req.from ?? to - nominalMs(tf) * (req.limit ?? 500) * intradayFactor - 4 * DAY_MS;
        from = Math.max(from, now - plan.maxAgeMs);
        if (from >= to) return [];

        const chunks: Array<[number, number]> = [];
        for (let end = to; end > from; end -= plan.maxSpanMs) chunks.push([Math.max(from, end - plan.maxSpanMs), end]);
        const parts = await Promise.all(chunks.map(([a, b]) => this.fetchChunk(ticker, plan, a, b, extended)));
        // Bucket in the venue's own zone as Yahoo reports it: its daily rows are stamped
        // at that zone's session start, so another zone could move them across midnight.
        const tz = parts.find((p) => p.tz)?.tz ?? entry.timezone;
        let bars = normalizeBars(parts.flatMap((p) => p.bars));
        // Fold to the plan's base first (the trailing live point is not interval-aligned),
        // then to the requested timeframe.
        if (plan.base.unit === 'minute') {
            const open = extended ? EXTENDED_ANCHOR_MS : sessionOpenOfDay(bars, tz);
            bars = aggregate(bars, plan.base, tz, open % (plan.base.n * 60_000));
            if (tf.unit === 'minute' && tf.n !== plan.base.n) bars = aggregate(bars, tf, tz, open % (tf.n * 60_000));
            else if (tf.unit !== 'minute') bars = aggregate(bars, tf, tz);
        } else {
            bars = aggregate(bars, plan.base, tz);
            if (plan.base.unit !== tf.unit || plan.base.n !== tf.n) bars = aggregate(bars, tf, tz);
        }
        return clip(bars, { from: req.from, to: req.to, limit: req.limit });
    }

    private fetchChunk(ticker: string, plan: Plan, from: number, to: number, extended = false): Promise<{ tz: string | null; bars: OHLCV[] }> {
        const live = to > Date.now() - 2 * DAY_MS;
        const step = plan.base.unit === 'minute' ? 60_000 : DAY_MS;
        const a = Math.floor(from / step) * step;
        const b = live ? Math.floor(to / 60_000) * 60_000 : Math.ceil(to / step) * step;
        const key = `${ticker}|${plan.interval}|${a}|${b}${extended ? '|ext' : ''}`;
        const ttl = live ? (plan.base.unit === 'minute' ? 30_000 : 120_000) : 12 * 3_600_000;
        return this.chunkCache.wrap(key, ttl, async () => {
            const [r] = await this.chart(ticker, { interval: plan.interval, period1: String(Math.floor(a / 1000)), period2: String(Math.ceil(b / 1000) + 60), ...(extended ? { includePrePost: 'true' } : {}) });
            const tz = r?.meta.exchangeTimezoneName ?? null;
            const out: OHLCV[] = [];
            const q = r?.indicators.quote[0];
            if (!r?.timestamp || !q) return { tz, bars: out };
            let missingLatest = false;
            for (let i = 0; i < r.timestamp.length; i++) {
                const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
                if (o == null || h == null || l == null || c == null) {
                    if (i >= r.timestamp.length - 2) missingLatest = true;
                    continue;
                }
                let t = r.timestamp[i]! * 1000;
                if (plan.base.unit !== 'minute' && tz) t = localMidnight(tz, t);
                out.push({ time: t, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
            }
            // Yahoo sometimes leaves the current session's daily row empty; rebuild it from 5-minute bars.
            if (live && plan.interval === '1d' && missingLatest && tz) {
                const today = await this.todayFromIntraday(ticker, tz).catch(() => null);
                if (today && !out.some((x) => x.time === today.time)) out.push(today);
            }
            return { tz, bars: out };
        });
    }

    private async todayFromIntraday(ticker: string, tz: string): Promise<OHLCV | null> {
        const [r] = await this.chart(ticker, { interval: '5m', range: '1d' });
        const q = r?.indicators.quote[0];
        if (!r?.timestamp || !q) return null;
        const rows: OHLCV[] = [];
        for (let i = 0; i < r.timestamp.length; i++) {
            const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
            if (o == null || h == null || l == null || c == null) continue;
            rows.push({ time: r.timestamp[i]! * 1000, open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
        }
        const day = aggregate(normalizeBars(rows), { unit: 'day', n: 1 }, tz);
        return day[day.length - 1] ?? null;
    }

    async quotes(tickers: string[]): Promise<Map<string, Quote>> {
        const out = new Map<string, Quote>();
        await Promise.all(
            tickers.map(async (t) => {
                const q = await this.quoteCache
                    .wrap(t, 60_000, async () => {
                        const [r] = await this.chart(t, { interval: '1d', range: '1d' });
                        const m = r?.meta;
                        if (m?.regularMarketPrice == null) return null;
                        return { price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? null, time: (m.regularMarketTime ?? Date.now() / 1000) * 1000 };
                    })
                    .catch(() => this.quoteCache.stale(t) ?? null);
                if (q) out.set(t, q);
            }),
        );
        return out;
    }

    async extendedQuotes(tickers: string[]): Promise<Map<string, ExtendedQuote>> {
        const now = Date.now();
        const age = (t: string) => now - (this.extCache.get(t)?.at ?? 0);
        // Oldest first, and only as many as the bucket can spare: a long watchlist refreshes
        // round-robin across calls instead of starving chart loads of their budget.
        const due = tickers.filter((t) => age(t) > EXT_FRESH_MS).sort((x, y) => age(y) - age(x));
        const spare = Math.max(0, Math.floor(this.bucket.available() - EXT_RESERVE));
        await Promise.all(
            due.slice(0, spare).map(async (t) => {
                const value = await this.fetchExtended(t).catch(() => undefined);
                if (value !== undefined) this.extCache.set(t, { value, at: Date.now() });
            }),
        );
        const out = new Map<string, ExtendedQuote>();
        for (const t of tickers) {
            const e = this.extCache.get(t);
            if (e?.value && Date.now() - e.at <= EXT_MAX_AGE_MS) out.set(t, e.value);
        }
        return out;
    }

    /** The newest bar of today's full tape, when it lies in the pre- or post-market. */
    private async fetchExtended(ticker: string): Promise<ExtendedQuote | null> {
        const [r] = await this.chart(ticker, { interval: '1m', range: '1d', includePrePost: 'true' });
        return r ? extendedFromChart(r.meta, r.timestamp ?? [], r.indicators.quote[0]?.close ?? []) : null;
    }
}

/** Classify the newest priced point of a 1-minute, pre/post-inclusive chart against its
 *  trading periods. */
export function extendedFromChart(
    meta: { regularMarketPrice?: number; tradingPeriods?: unknown },
    timestamps: readonly number[],
    closes: ReadonlyArray<number | null>,
): ExtendedQuote | null {
    let i = timestamps.length - 1;
    while (i >= 0 && closes[i] == null) i--;
    if (i < 0) return null;
    const t = timestamps[i]!;
    const periods = (meta.tradingPeriods ?? {}) as { pre?: TradingPeriod[][]; post?: TradingPeriod[][] };
    const within = (rows: TradingPeriod[][] | undefined) => (Array.isArray(rows) ? rows.flat().some((p) => t >= p.start && t < p.end) : false);
    const session = within(periods.pre) ? 'pre' : within(periods.post) ? 'post' : null;
    if (!session) return null;
    return { session, price: closes[i]!, base: meta.regularMarketPrice ?? null, time: t * 1000 };
}
