// Day-ahead electricity prices from the Energy-Charts API (Fraunhofer ISE; no key,
// CC BY 4.0). A price series has no trades: each delivery slot (15 min since the
// market's October 2025 switch, hourly before) becomes one flat bar, and larger
// timeframes fold those into real OHLC. Tomorrow's prices publish around 13:00 CET,
// so the newest bars lie in the future.
import type { Bridge, BarRequest, CatalogEntry, OHLCV, Quote } from '../types';
import { UpstreamError } from '../types';
import { TokenBucket, TtlCache, fetchJson } from '../limits';
import { aggregate, clip, localDate, nominalMs, type Timeframe } from '../timeframes';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.energy-charts.info/price';
const TZ = 'Europe/Brussels';
const DAY_MS = 86_400_000;
/** The Belgian zone's history on the API starts here. */
const EARLIEST = Date.UTC(2015, 0, 1);

export const ENERGY_ATTRIBUTION = 'Day-ahead prices: Energy-Charts.info (Fraunhofer ISE), CC BY 4.0';

interface PriceResponse {
    unix_seconds?: number[];
    price?: (number | null)[];
    unit?: string;
}

export class EnergyChartsBridge implements Bridge {
    readonly id = 'energycharts' as const;
    readonly pollMs = 15 * 60_000;
    // The API throttles bursts; closed ranges are also kept on disk, so this budget is
    // spent mostly on the first load of a long history.
    private readonly bucket = new TokenBucket(15, 3, 'energycharts');
    private readonly cache = new TtlCache<OHLCV[]>(400, 'energycharts');

    constructor(private readonly diskDir: string | null = null) {}

    supports(tf: Timeframe): boolean {
        return tf.unit !== 'minute' || tf.n >= 15;
    }

    async getBars(zone: string, tf: Timeframe, req: BarRequest): Promise<OHLCV[]> {
        if (!this.supports(tf)) throw new UpstreamError('Day-ahead prices have 15-minute resolution — pick 15m or higher.', 400);
        const now = Date.now();
        // The newest published slot is tomorrow evening.
        const to = req.to ?? now + 2 * DAY_MS;
        const slotsPerBar = tf.unit === 'minute' ? tf.n / 15 : nominalMs(tf) / (15 * 60_000);
        const from = Math.max(EARLIEST, req.from ?? to - nominalMs(tf) * (req.limit ?? 500) * (slotsPerBar > 4 ? 1.05 : 1.2) - DAY_MS);
        // Newest first, one at a time: if an older range fails, the chart still gets the
        // recent history instead of an error.
        const parts: OHLCV[][] = [];
        const chunks = chunksBetween(from, to, now).reverse();
        for (let i = 0; i < chunks.length; i++) {
            try {
                parts.unshift(await this.chunk(zone, chunks[i]!));
            } catch (err) {
                if (i === 0) throw err;
                break;
            }
        }
        const slots = parts.flat().filter((b) => b.time >= from - DAY_MS && b.time <= to);
        const bars = aggregate(slots, tf, TZ);
        return clip(bars, { from: req.from, to: req.to, limit: req.limit });
    }

    /** One date range of slots (Brussels dates, inclusive). Closed ranges never change. */
    private chunk(zone: string, c: Chunk): Promise<OHLCV[]> {
        return this.cache.wrap(`${zone}|${c.start}|${c.end}`, c.closed ? 7 * DAY_MS : 15 * 60_000, async () => {
            const file = c.closed && this.diskDir ? path.join(this.diskDir, `${zone.replace(/\W/g, '')}-${c.start}-${c.end}.json`) : null;
            if (file && fs.existsSync(file)) {
                try {
                    return JSON.parse(fs.readFileSync(file, 'utf8')) as OHLCV[];
                } catch {
                    // Corrupt cache file: refetch below.
                }
            }
            const bars = await this.fetchRange(zone, c);
            if (file && bars.length > 0) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(bars));
            }
            return bars;
        });
    }

    private async fetchRange(zone: string, c: Chunk): Promise<OHLCV[]> {
        await this.bucket.take(60_000);
        const res = await fetchJson<PriceResponse>(`${BASE}?bzn=${encodeURIComponent(zone)}&start=${c.start}&end=${c.end}`, { timeoutMs: 45_000, bridge: 'energycharts', tag: c.closed ? 'price:history' : 'price:current' });
        const out: OHLCV[] = [];
        const ts = res.unix_seconds ?? [];
        const px = res.price ?? [];
        for (let i = 0; i < ts.length; i++) {
            const p = px[i];
            if (p == null || !Number.isFinite(p)) continue;
            out.push({ time: ts[i]! * 1000, open: p, high: p, low: p, close: p, volume: 0 });
        }
        return out;
    }

    /** The slot in force now, against the same slot 24 h earlier. */
    async quotes(zones: string[], _entries: CatalogEntry[]): Promise<Map<string, Quote>> {
        const out = new Map<string, Quote>();
        const now = Date.now();
        for (const zone of zones) {
            const bars = await this.getBars(zone, { unit: 'minute', n: 15 }, { from: now - 2 * DAY_MS, to: now }).catch(() => []);
            const cur = bars[bars.length - 1];
            if (!cur) continue;
            const prev = [...bars].reverse().find((b) => b.time <= cur.time - DAY_MS);
            out.set(zone, { price: cur.close, prevClose: prev?.close ?? null, time: cur.time });
        }
        return out;
    }
}

interface Chunk {
    start: string;
    end: string;
    closed: boolean;
}

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/**
 * Request ranges covering [from, to]: whole years before this one, then this year's past
 * months as one block, then the current month (and the next, once tomorrow's prices
 * reach into it). Closed ranges are cached for days; only the open tail is refetched.
 */
export function chunksBetween(from: number, to: number, now: number): Chunk[] {
    const [ny, nm] = localDate(TZ, now).split('-').map(Number) as [number, number];
    const fromY = Number(localDate(TZ, from).slice(0, 4));
    const toDate = localDate(TZ, to);
    const toY = Number(toDate.slice(0, 4));
    const toYm = toDate.slice(0, 7);
    const out: Chunk[] = [];
    for (let y = fromY; y <= toY; y++) {
        if (y < ny) {
            out.push({ start: `${y}-01-01`, end: `${y}-12-31`, closed: true });
            continue;
        }
        const firstOpen = y === ny ? nm - 1 : 0;
        if (y === ny && firstOpen > 0) out.push({ start: `${y}-01-01`, end: ymd(y, firstOpen, 0), closed: true });
        for (let m = firstOpen; m < 12; m++) {
            const start = ymd(y, m, 1);
            if (start.slice(0, 7) > toYm) break;
            out.push({ start, end: ymd(y, m + 1, 0), closed: false });
        }
    }
    // Only ranges that reach `from`.
    const fromDate = localDate(TZ, from);
    return out.filter((c) => c.end >= fromDate);
}
