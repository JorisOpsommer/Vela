// One underlying's option chain, read the way a trader reads it: where the open interest
// sits, what the market prices for the coming move, and where dealer hedging may pin or
// push the price. Pure functions of the contracts list (open interest), the snapshots
// (quotes, greeks, implied volatility) and the spot price — the daily job and the page's
// on-demand load share them.
import type { RawOptionContract, RawOptionSnapshot } from '../market/bridges/alpaca';
import { localDate, zonedWallTime } from '../market/timeframes';
import { gammaOf, greeks as modelGreeks, impliedVol } from './model';

const NY = 'America/New_York';
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
/** Snapshots are pulled for strikes this far either side of spot… */
export const STRIKE_BAND = 0.25;
/** …expiring within this many days; open interest is read for every listed expiry up to {@link OI_HORIZON_DAYS}. */
export const QUOTE_HORIZON_DAYS = 90;
export const OI_HORIZON_DAYS = 730;
/** The flip sweep: spot ± this, in this many steps. */
const FLIP_BAND = 0.15;
const FLIP_STEPS = 60;
const TOP_N = 8;
/** Unusual activity: at least this much premium traded, and volume this many times the open interest. */
const UNUSUAL_PREMIUM = 50_000;
const UNUSUAL_RATIO = 1.5;

export interface ChainContract {
    occ: string;
    right: 'C' | 'P';
    expiry: string;
    strike: number;
    multiplier: number;
    oi: number;
    mid: number | null;
    volume: number;
    iv: number | null;
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    /** The greeks were filled in by our model (the feed had none for this contract). */
    modeled: boolean;
}

export interface ContractRow {
    occ: string;
    right: 'C' | 'P';
    expiry: string;
    strike: number;
    oi: number;
    volume: number;
    iv: number | null;
    mid: number | null;
}

export interface StrikeRow {
    strike: number;
    callOI: number;
    putOI: number;
    /** Dealer gamma exposure, dollars per 1% move: calls positive, puts negative. */
    callGex: number;
    putGex: number;
}

export interface ExpiryRow {
    expiry: string;
    days: number;
    callOI: number;
    putOI: number;
    atmIV: number | null;
    maxPain: number | null;
    /** One standard deviation by expiry, from the at-the-money volatility. */
    move: number | null;
}

/** The headline numbers, one row per symbol per trading day — kept as history. */
export interface OptionsSummary {
    date: string;
    oiDate: string | null;
    spot: number;
    callOI: number;
    putOI: number;
    pcrOI: number | null;
    callVolume: number;
    putVolume: number;
    pcrVolume: number | null;
    /** 30-day at-the-money implied volatility (variance-interpolated across expiries). */
    iv30: number | null;
    /** 25-delta put IV minus 25-delta call IV near 30 days: positive = downside priced richer. */
    skew25: number | null;
    expectedMove: { expiry: string; days: number; amount: number; pct: number } | null;
    maxPain: { expiry: string; strike: number } | null;
    netGex: number | null;
    gammaFlip: number | null;
    callWall: number | null;
    putWall: number | null;
    contracts: number;
    quoted: number;
    /** Share of quoted contracts whose greeks came from the feed rather than our model. */
    feedGreeks: number | null;
}

export interface OptionsDetail {
    strikes: StrikeRow[];
    expiries: ExpiryRow[];
    smile: { expiry: string; points: Array<{ strike: number; callIV: number | null; putIV: number | null }> } | null;
    /** Net dealer gamma exposure if spot moved to `price`. */
    gexCurve: Array<{ price: number; gex: number }>;
    /** Today's volume well above the standing open interest — new positions opening. */
    unusual: Array<ContractRow & { ratio: number; premium: number }>;
    topOI: ContractRow[];
}

/** The quote and open-interest windows for an underlying at `spot`, as of `now`. */
export function chainWindow(spot: number, now: number): { expiresBy: string; quotedBy: string; strikeMin: number; strikeMax: number } {
    return {
        expiresBy: localDate(NY, now + OI_HORIZON_DAYS * DAY_MS),
        quotedBy: localDate(NY, now + QUOTE_HORIZON_DAYS * DAY_MS),
        strikeMin: Math.floor(spot * (1 - STRIKE_BAND) * 100) / 100,
        strikeMax: Math.ceil(spot * (1 + STRIKE_BAND) * 100) / 100,
    };
}

/** Expiry instant: 16:00 New York on the expiration date. */
function expiryAt(date: string): number {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return zonedWallTime(NY, y, m - 1, d, 16 * 3_600_000);
}

function years(expiry: string, now: number): number {
    return Math.max(expiryAt(expiry) - now, 3_600_000) / YEAR_MS;
}

const num = (v: string | number | null | undefined): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Join the contracts (open interest) with their snapshots (quotes, greeks). Contracts the
 * feed quoted without greeks get model greeks from their mid price; volume counts only
 * when the snapshot's daily bar is from `session` (the trading day being read).
 */
export function buildChain(contracts: readonly RawOptionContract[], snaps: ReadonlyMap<string, RawOptionSnapshot>, spot: number, now: number, session: string): ChainContract[] {
    const out: ChainContract[] = [];
    for (const c of contracts) {
        const right = c.type === 'call' ? 'C' : 'P';
        const strike = num(c.strike_price);
        if (!(strike > 0)) continue;
        const s = snaps.get(c.symbol);
        const bid = s?.latestQuote?.bp ?? 0;
        const ask = s?.latestQuote?.ap ?? 0;
        const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : (s?.latestTrade?.p ?? null);
        const volume = s?.dailyBar && localDate(NY, Date.parse(s.dailyBar.t) + 12 * 3_600_000) === session ? s.dailyBar.v : 0;
        let iv = s?.impliedVolatility ?? null;
        let g = s?.greeks ?? null;
        let modeled = false;
        if (s && (!g || iv == null) && mid != null) {
            const t = years(c.expiration_date, now);
            iv ??= impliedVol(right === 'C', mid, spot, strike, t);
            if (iv != null) {
                g = { ...modelGreeks(right === 'C', spot, strike, t, iv), rho: 0 };
                modeled = true;
            }
        }
        out.push({
            occ: c.symbol,
            right,
            expiry: c.expiration_date,
            strike,
            multiplier: num(c.multiplier) || 100,
            oi: num(c.open_interest),
            mid,
            volume,
            iv,
            delta: g?.delta ?? null,
            gamma: g?.gamma ?? null,
            theta: g?.theta ?? null,
            vega: g?.vega ?? null,
            modeled,
        });
    }
    return out;
}

/** The strike minimizing what option holders would collect at expiry. */
export function maxPain(chain: readonly ChainContract[]): number | null {
    const strikes = [...new Set(chain.map((c) => c.strike))].sort((a, b) => a - b);
    let best: number | null = null;
    let bestPain = Infinity;
    for (const k of strikes) {
        let pain = 0;
        for (const c of chain) pain += c.oi * c.multiplier * Math.max(0, c.right === 'C' ? k - c.strike : c.strike - k);
        if (pain < bestPain) {
            bestPain = pain;
            best = k;
        }
    }
    return best;
}

/** At-the-money IV of one expiry: the call and put at the strike nearest spot, averaged. */
function atmIV(chain: readonly ChainContract[], spot: number): number | null {
    const withIV = chain.filter((c) => c.iv != null);
    if (withIV.length === 0) return null;
    const k = withIV.reduce((a, c) => (Math.abs(c.strike - spot) < Math.abs(a - spot) ? c.strike : a), withIV[0]!.strike);
    const at = withIV.filter((c) => c.strike === k).map((c) => c.iv!);
    return at.reduce((a, b) => a + b, 0) / at.length;
}

/** Third Friday of the expiry's month — the standard monthly expiration. */
function isMonthly(expiry: string): boolean {
    const [y, m, d] = expiry.split('-').map(Number) as [number, number, number];
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return (wd === 5 && d >= 15 && d <= 21) || (wd === 4 && d >= 14 && d <= 20);
}

/** Net dealer gamma exposure at `spot` (calls long gamma for dealers' hedges, puts short). */
function netGexAt(chain: readonly ChainContract[], spot: number, now: number): number {
    let total = 0;
    for (const c of chain) {
        if (c.iv == null || c.oi <= 0) continue;
        const g = gammaOf(spot, c.strike, years(c.expiry, now), c.iv);
        const exposure = g * c.oi * c.multiplier * spot * spot * 0.01;
        total += c.right === 'C' ? exposure : -exposure;
    }
    return total;
}

function row(c: ChainContract): ContractRow {
    return { occ: c.occ, right: c.right, expiry: c.expiry, strike: c.strike, oi: c.oi, volume: c.volume, iv: c.iv, mid: c.mid };
}

export function analyzeChain(chain: readonly ChainContract[], spot: number, now: number, date: string, oiDate: string | null): { summary: OptionsSummary; detail: OptionsDetail } {
    const sum = (xs: readonly ChainContract[], f: (c: ChainContract) => number) => xs.reduce((a, c) => a + f(c), 0);
    const calls = chain.filter((c) => c.right === 'C');
    const puts = chain.filter((c) => c.right === 'P');
    const callOI = sum(calls, (c) => c.oi);
    const putOI = sum(puts, (c) => c.oi);
    const callVolume = sum(calls, (c) => c.volume);
    const putVolume = sum(puts, (c) => c.volume);
    const quoted = chain.filter((c) => c.iv != null);
    const today = localDate(NY, now);

    const byExpiry = new Map<string, ChainContract[]>();
    for (const c of chain) {
        if (c.expiry < today) continue;
        const list = byExpiry.get(c.expiry);
        if (list) list.push(c);
        else byExpiry.set(c.expiry, [c]);
    }
    const expiries: ExpiryRow[] = [...byExpiry.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([expiry, list]) => {
            const days = Math.max(0, (expiryAt(expiry) - now) / DAY_MS);
            const iv = atmIV(list, spot);
            return {
                expiry,
                days: Math.round(days * 10) / 10,
                callOI: sum(list.filter((c) => c.right === 'C'), (c) => c.oi),
                putOI: sum(list.filter((c) => c.right === 'P'), (c) => c.oi),
                atmIV: iv,
                maxPain: maxPain(list),
                move: iv != null ? spot * iv * Math.sqrt(Math.max(days, 1 / 24) / 365) : null,
            };
        });

    // 30-day IV: interpolate total variance between the expiries around 30 days.
    const ivd = expiries.filter((e) => e.atmIV != null && e.days >= 1);
    let iv30: number | null = null;
    if (ivd.length > 0) {
        const after = ivd.find((e) => e.days >= 30);
        const before = [...ivd].reverse().find((e) => e.days <= 30);
        if (before && after && before !== after) {
            const w1 = before.atmIV! ** 2 * before.days;
            const w2 = after.atmIV! ** 2 * after.days;
            iv30 = Math.sqrt((w1 + ((w2 - w1) * (30 - before.days)) / (after.days - before.days)) / 30);
        } else iv30 = (after ?? before)!.atmIV;
    }

    // Skew at the expiry nearest 30 days: the 25-delta put against the 25-delta call.
    let skew25: number | null = null;
    const skewExpiry = ivd.reduce<ExpiryRow | null>((a, e) => (!a || Math.abs(e.days - 30) < Math.abs(a.days - 30) ? e : a), null);
    if (skewExpiry) {
        const list = byExpiry.get(skewExpiry.expiry)!.filter((c) => c.delta != null && c.iv != null);
        const nearest = (right: 'C' | 'P', target: number) =>
            list.filter((c) => c.right === right).reduce<ChainContract | null>((a, c) => (!a || Math.abs(c.delta! - target) < Math.abs(a.delta! - target) ? c : a), null);
        const p = nearest('P', -0.25);
        const c = nearest('C', 0.25);
        if (p && c && Math.abs(p.delta! + 0.25) < 0.1 && Math.abs(c.delta! - 0.25) < 0.1) skew25 = p.iv! - c.iv!;
    }

    const front = expiries.find((e) => e.days >= 5 && e.move != null) ?? expiries.find((e) => e.move != null) ?? null;
    const monthly = expiries.find((e) => isMonthly(e.expiry) && e.days >= 1) ?? expiries[0] ?? null;

    // Strikes inside the quoted band, every expiry within the quote horizon.
    const lo = spot * (1 - STRIKE_BAND);
    const hi = spot * (1 + STRIKE_BAND);
    const horizon = localDate(NY, now + QUOTE_HORIZON_DAYS * DAY_MS);
    const near = chain.filter((c) => c.strike >= lo && c.strike <= hi && c.expiry >= today && c.expiry <= horizon);
    const strikeMap = new Map<number, StrikeRow>();
    for (const c of near) {
        const r = strikeMap.get(c.strike) ?? { strike: c.strike, callOI: 0, putOI: 0, callGex: 0, putGex: 0 };
        const gex = c.gamma != null ? c.gamma * c.oi * c.multiplier * spot * spot * 0.01 : 0;
        if (c.right === 'C') {
            r.callOI += c.oi;
            r.callGex += gex;
        } else {
            r.putOI += c.oi;
            r.putGex -= gex;
        }
        strikeMap.set(c.strike, r);
    }
    const strikes = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);
    const hasGex = near.some((c) => c.gamma != null && c.oi > 0);
    const netGex = hasGex ? strikes.reduce((a, s) => a + s.callGex + s.putGex, 0) : null;
    const callWall = hasGex ? strikes.reduce<StrikeRow | null>((a, s) => (!a || s.callGex > a.callGex ? s : a), null)?.strike ?? null : null;
    const putWall = hasGex ? strikes.reduce<StrikeRow | null>((a, s) => (!a || s.putGex < a.putGex ? s : a), null)?.strike ?? null : null;

    // Where net gamma changes sign: re-price every quoted contract's gamma across a spot sweep.
    const gexCurve: OptionsDetail['gexCurve'] = [];
    let gammaFlip: number | null = null;
    if (hasGex) {
        for (let i = 0; i <= FLIP_STEPS; i++) {
            const p = spot * (1 - FLIP_BAND + (2 * FLIP_BAND * i) / FLIP_STEPS);
            gexCurve.push({ price: Math.round(p * 100) / 100, gex: netGexAt(near, p, now) });
        }
        for (let i = 1; i < gexCurve.length; i++) {
            const a = gexCurve[i - 1]!;
            const b = gexCurve[i]!;
            if (Math.sign(a.gex) === Math.sign(b.gex) || a.gex === b.gex) continue;
            const x = a.price + ((b.price - a.price) * -a.gex) / (b.gex - a.gex);
            if (gammaFlip == null || Math.abs(x - spot) < Math.abs(gammaFlip - spot)) gammaFlip = Math.round(x * 100) / 100;
        }
    }

    let smile: OptionsDetail['smile'] = null;
    const smileExpiry = monthly && byExpiry.get(monthly.expiry)?.some((c) => c.iv != null) ? monthly : front;
    if (smileExpiry) {
        const list = byExpiry.get(smileExpiry.expiry)!.filter((c) => c.strike >= lo && c.strike <= hi);
        const ks = [...new Set(list.map((c) => c.strike))].sort((a, b) => a - b);
        smile = {
            expiry: smileExpiry.expiry,
            points: ks
                .map((k) => ({ strike: k, callIV: list.find((c) => c.strike === k && c.right === 'C')?.iv ?? null, putIV: list.find((c) => c.strike === k && c.right === 'P')?.iv ?? null }))
                .filter((p) => p.callIV != null || p.putIV != null),
        };
    }

    const unusual = chain
        .map((c) => ({ c, premium: c.volume * (c.mid ?? 0) * c.multiplier }))
        .filter(({ c, premium }) => premium >= UNUSUAL_PREMIUM && c.volume >= UNUSUAL_RATIO * Math.max(c.oi, 1))
        .map(({ c, premium }) => ({ ...row(c), ratio: c.volume / Math.max(c.oi, 1), premium }))
        .sort((a, b) => b.premium - a.premium)
        .slice(0, TOP_N);
    const topOI = [...chain].sort((a, b) => b.oi - a.oi).slice(0, TOP_N).map(row);

    return {
        summary: {
            date,
            oiDate,
            spot,
            callOI,
            putOI,
            pcrOI: callOI > 0 ? putOI / callOI : null,
            callVolume,
            putVolume,
            pcrVolume: callVolume > 0 ? putVolume / callVolume : null,
            iv30,
            skew25,
            expectedMove: front && front.move != null ? { expiry: front.expiry, days: front.days, amount: front.move, pct: front.move / spot } : null,
            maxPain: monthly && monthly.maxPain != null ? { expiry: monthly.expiry, strike: monthly.maxPain } : null,
            netGex,
            gammaFlip,
            callWall,
            putWall,
            contracts: chain.length,
            quoted: quoted.length,
            feedGreeks: quoted.length > 0 ? quoted.filter((c) => !c.modeled).length / quoted.length : null,
        },
        detail: { strikes, expiries, smile, gexCurve, unusual, topOI },
    };
}
