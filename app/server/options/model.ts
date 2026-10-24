// Black-Scholes for European options on a non-dividend-paying underlying: prices, greeks,
// and implied volatility from a price. US equity options are American, so these are the
// usual approximation — good for the exposure estimates the options page shows, not for
// pricing a trade.

/** Annual risk-free rate the model assumes (short-dated Treasury bills, roughly). */
export const RISK_FREE = 0.04;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

export interface Greeks {
    delta: number;
    gamma: number;
    /** Per calendar day. */
    theta: number;
    /** Per one volatility point (0.01). */
    vega: number;
}

function pdf(x: number): number {
    return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 7.5e-8). */
export function cdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const p = 1 - pdf(x) * poly;
    return x >= 0 ? p : 1 - p;
}

function d1d2(spot: number, strike: number, years: number, vol: number, r: number): [number, number] {
    const sd = vol * Math.sqrt(years);
    const d1 = (Math.log(spot / strike) + (r + 0.5 * vol * vol) * years) / sd;
    return [d1, d1 - sd];
}

export function price(call: boolean, spot: number, strike: number, years: number, vol: number, r = RISK_FREE): number {
    if (years <= 0 || vol <= 0) return Math.max(0, call ? spot - strike : strike - spot);
    const [d1, d2] = d1d2(spot, strike, years, vol, r);
    const df = Math.exp(-r * years);
    return call ? spot * cdf(d1) - strike * df * cdf(d2) : strike * df * cdf(-d2) - spot * cdf(-d1);
}

export function greeks(call: boolean, spot: number, strike: number, years: number, vol: number, r = RISK_FREE): Greeks {
    const [d1, d2] = d1d2(spot, strike, years, vol, r);
    const sqrtT = Math.sqrt(years);
    const df = Math.exp(-r * years);
    const gamma = pdf(d1) / (spot * vol * sqrtT);
    const decay = (-spot * pdf(d1) * vol) / (2 * sqrtT);
    const theta = call ? decay - r * strike * df * cdf(d2) : decay + r * strike * df * cdf(-d2);
    return { delta: call ? cdf(d1) : cdf(d1) - 1, gamma, theta: theta / 365, vega: (spot * pdf(d1) * sqrtT) / 100 };
}

/** Just the gamma — the exposure sweep calls this thousands of times. */
export function gammaOf(spot: number, strike: number, years: number, vol: number, r = RISK_FREE): number {
    const [d1] = d1d2(spot, strike, years, vol, r);
    return pdf(d1) / (spot * vol * Math.sqrt(years));
}

/**
 * The volatility that prices the option at `premium`, by bisection; null when no
 * volatility in (1%, 500%) reaches it (a premium under intrinsic value, or a stale quote).
 */
export function impliedVol(call: boolean, premium: number, spot: number, strike: number, years: number, r = RISK_FREE): number | null {
    if (!(premium > 0) || years <= 0) return null;
    let lo = 0.01;
    let hi = 5;
    if (price(call, spot, strike, years, lo, r) > premium || price(call, spot, strike, years, hi, r) < premium) return null;
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (price(call, spot, strike, years, mid, r) < premium) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-5) break;
    }
    return (lo + hi) / 2;
}
