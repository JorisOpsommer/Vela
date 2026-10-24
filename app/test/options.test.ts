// The options read: the pricing model, the chain analytics a trader reads, the stored
// history, and the daily job riding the warmer's passes.
import { describe, expect, it } from 'vitest';
import { cdf, greeks, impliedVol, price } from '../server/options/model';
import { analyzeChain, buildChain, maxPain, type ChainContract } from '../server/options/chain';
import { ivRank, OptionsService, assetTerms, type StoredDay } from '../server/options/service';
import { optionsJob } from '../server/options/job';
import { openDbAt } from '../server/db';
import type { RawOptionContract, RawOptionSnapshot } from '../server/market/bridges/alpaca';
import type { MarketService } from '../server/market/service';
import type { WarmPlan } from '../server/market/warm-targets';

const NOW = Date.UTC(2026, 9, 23, 21, 0); // Fri 17:00 New York, after the close

function contract(right: 'C' | 'P', strike: number, oi: number, expiry = '2026-11-20', extra: Partial<ChainContract> = {}): ChainContract {
    return { occ: `X${expiry}${right}${strike}`, right, expiry, strike, multiplier: 100, oi, mid: 1, volume: 0, iv: 0.3, delta: null, gamma: null, theta: null, vega: null, modeled: false, ...extra };
}

describe('pricing model', () => {
    it('prices a textbook call and put, with put-call parity', () => {
        expect(cdf(0)).toBeCloseTo(0.5, 6);
        const call = price(true, 100, 100, 1, 0.2, 0.04);
        const put = price(false, 100, 100, 1, 0.2, 0.04);
        expect(call).toBeCloseTo(9.925, 2);
        expect(call - put).toBeCloseTo(100 - 100 * Math.exp(-0.04), 6);
    });

    it('recovers the volatility from a price, and refuses a premium under intrinsic value', () => {
        const p = price(false, 95, 100, 0.25, 0.45);
        expect(impliedVol(false, p, 95, 100, 0.25)).toBeCloseTo(0.45, 3);
        expect(impliedVol(true, 4, 110, 100, 0.25)).toBeNull();
    });

    it('gives calls positive and puts negative delta, gamma peaking at the money', () => {
        const atm = greeks(true, 100, 100, 0.1, 0.3);
        expect(atm.delta).toBeGreaterThan(0.5);
        expect(greeks(false, 100, 100, 0.1, 0.3).delta).toBeLessThan(0);
        expect(atm.gamma).toBeGreaterThan(greeks(true, 100, 130, 0.1, 0.3).gamma);
        expect(atm.theta).toBeLessThan(0);
    });
});

describe('chain analytics', () => {
    it('finds max pain where holders collect the least', () => {
        const chain = [contract('C', 90, 1000), contract('C', 100, 200), contract('P', 110, 1000), contract('P', 100, 200)];
        // Calls below and puts above: both pay least when the price ends between them.
        expect(maxPain(chain)).toBe(100);
    });

    it('joins open interest with snapshots, models missing greeks, and counts only the session volume', () => {
        const contracts: RawOptionContract[] = [
            { symbol: 'A1', type: 'call', expiration_date: '2026-11-20', strike_price: '100', open_interest: '500', open_interest_date: '2026-10-22' },
            { symbol: 'A2', type: 'put', expiration_date: '2026-11-20', strike_price: '100', open_interest: '300', open_interest_date: '2026-10-22' },
            { symbol: 'A3', type: 'call', expiration_date: '2026-11-20', strike_price: '200', open_interest: '7' },
        ];
        const snaps = new Map<string, RawOptionSnapshot>([
            ['A1', { latestQuote: { bp: 4.9, ap: 5.1, t: '' }, impliedVolatility: 0.31, greeks: { delta: 0.55, gamma: 0.03, theta: -0.05, vega: 0.12, rho: 0.04 }, dailyBar: { t: '2026-10-23T04:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1200 } }],
            ['A2', { latestQuote: { bp: 3.9, ap: 4.1, t: '' }, dailyBar: { t: '2026-10-22T04:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 999 } }],
        ]);
        const chain = buildChain(contracts, snaps, 100, NOW, '2026-10-23');
        const [c, p, far] = chain;
        expect(c).toMatchObject({ oi: 500, mid: 5, iv: 0.31, delta: 0.55, volume: 1200, modeled: false });
        expect(p!.modeled).toBe(true);
        expect(p!.iv).toBeGreaterThan(0.1);
        expect(p!.delta).toBeLessThan(0);
        expect(p!.volume).toBe(0); // yesterday's bar
        expect(far).toMatchObject({ oi: 7, iv: null, mid: null });
    });

    it('reads the headline numbers: put/call, expected move, walls, and a gamma flip between them', () => {
        const spot = 100;
        const chain: ChainContract[] = [];
        for (const k of [80, 85, 90, 95, 100, 105, 110, 115, 120]) {
            const g = (call: boolean) => greeks(call, spot, k, 28 / 365, 0.3);
            // Heavy puts below spot, heavy calls above: dealers' gamma flips from short to long.
            chain.push(contract('C', k, k > 100 ? 5000 : 500, '2026-11-20', { gamma: g(true).gamma, delta: g(true).delta }));
            chain.push(contract('P', k, k < 100 ? 8000 : 500, '2026-11-20', { gamma: g(false).gamma, delta: g(false).delta }));
        }
        const { summary, detail } = analyzeChain(chain, spot, NOW, '2026-10-23', '2026-10-22');
        expect(summary.pcrOI).toBeCloseTo(summary.putOI / summary.callOI, 9);
        expect(summary.iv30).toBeCloseTo(0.3, 6);
        expect(summary.expectedMove!.pct).toBeCloseTo(0.3 * Math.sqrt(summary.expectedMove!.days / 365), 6);
        expect(summary.callWall).toBeGreaterThan(spot);
        expect(summary.putWall).toBeLessThan(spot);
        expect(summary.gammaFlip).not.toBeNull();
        expect(summary.gammaFlip!).toBeGreaterThan(80);
        expect(summary.gammaFlip!).toBeLessThan(120);
        expect(detail.strikes.map((s) => s.strike)).toEqual([80, 85, 90, 95, 100, 105, 110, 115, 120]);
        expect(detail.smile?.expiry).toBe('2026-11-20');
    });

    it('flags only real new positioning as unusual: premium traded and volume over open interest', () => {
        const chain = [
            contract('P', 50, 0, '2026-11-20', { volume: 9000, mid: 0.01 }), // pennies — noise
            contract('C', 105, 2000, '2026-11-20', { volume: 1000, mid: 3 }), // under the open interest
            contract('C', 110, 1000, '2026-11-20', { volume: 6000, mid: 2 }), // $1.2M, 6x
        ];
        const { detail } = analyzeChain(chain, 100, NOW, '2026-10-23', null);
        expect(detail.unusual.map((u) => u.strike)).toEqual([110]);
        expect(detail.unusual[0]!.premium).toBe(1_200_000);
    });
});

describe('options history', () => {
    const day = (date: string, iv30: number | null): StoredDay => ({ date, fetchedAt: 0, strikes: null, summary: { iv30 } as never });

    it('ranks the current IV within its stored range once there is enough history', () => {
        expect(ivRank([day('d5', 0.3), day('d4', 0.2)])).toBeNull();
        const r = ivRank([day('d5', 0.25), day('d4', 0.2), day('d3', 0.4), day('d2', 0.3), day('d1', 0.2)]);
        expect(r!.rank).toBeCloseTo(0.25, 9);
        expect(r!.days).toBe(5);
    });

    it('reads the broker terms, options listing included', () => {
        expect(assetTerms({ symbol: 'A', name: 'A', exchange: 'X', class: 'us_equity', status: 'active', tradable: true, marginable: true, margin_requirement_long: '30', margin_requirement_short: 50, shortable: true, easy_to_borrow: false, attributes: ['has_options'] })).toEqual({
            marginable: true,
            marginLong: 30,
            marginShort: 50,
            maintenance: null,
            shortable: true,
            easyToBorrow: false,
            hasOptions: true,
        });
    });
});

describe('daily options job', () => {
    function world() {
        const db = openDbAt(':memory:');
        const calls: string[] = [];
        const entries: Record<string, { symbol: string; name: string; class: string }> = {
            AAPL: { symbol: 'AAPL', name: 'Apple', class: 'stock' },
            BTCUSD: { symbol: 'BTCUSD', name: 'Bitcoin', class: 'crypto' },
        };
        const alpaca = {
            assets: async () => [{ symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', class: 'us_equity', status: 'active', tradable: true, attributes: ['has_options'] }],
            calendar: async () => new Map([['2026-10-23', { open: NOW - 8 * 3_600_000, close: NOW - 3_600_000, sessionOpen: 0, sessionClose: 0 }]]),
            optionContracts: async (s: string) => {
                calls.push(`contracts ${s}`);
                return [{ symbol: 'C1', type: 'call', expiration_date: '2026-11-20', strike_price: '100', open_interest: '10', open_interest_date: '2026-10-22' }];
            },
            optionSnapshots: async (s: string) => {
                calls.push(`snapshots ${s}`);
                return new Map();
            },
        };
        const market = {
            bridges: { alpaca },
            resolve: (s: string) => entries[s] ?? null,
            quotes: async (s: string[]) => s.map((symbol) => ({ symbol, price: 100 })),
        } as unknown as MarketService;
        const options = new OptionsService(db, market, () => NOW);
        const plan = { targets: [], accounts: [], watched: new Map([['BTCUSD', 3], ['AAPL', 1]]) } as WarmPlan;
        return { db, calls, options, plan };
    }

    it('reads each watched optionable symbol once per trading day, after the close', async () => {
        const { calls, options, plan } = world();
        const job = optionsJob(options);
        expect(job.steps('intraday', plan)).toHaveLength(0);
        const steps = job.steps('close', plan);
        expect(steps.map((s) => s.label)).toEqual(['options BTCUSD', 'options AAPL', 'options history']);
        for (const s of steps) await s.run();
        expect(calls).toEqual(['contracts AAPL', 'snapshots AAPL']);
        expect(options.latest('AAPL')?.summary).toMatchObject({ date: '2026-10-23', oiDate: '2026-10-22', callOI: 10 });
        // A second pass the same day finds the read and asks nothing.
        for (const s of job.steps('manual', plan)) await s.run();
        expect(calls).toHaveLength(2);
        expect(options.history('AAPL')).toHaveLength(1);
    });
});
