// Trend reads: detected from the cached bars, redone only when a bar settles, loaded on
// demand for a symbol nothing cached yet, and served per account's watchlist.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDbAt } from '../server/db';
import { CachedMarket } from '../server/market/cached-market';
import { CacheStore } from '../server/market/cache-store';
import { Catalog } from '../server/market/catalog';
import { MarketService } from '../server/market/service';
import { TrendsService } from '../server/trends/service';
import { trendsJob } from '../server/trends/job';
import type { Bridge, OHLCV } from '../server/market/types';
import type { WarmPlan } from '../server/market/warm-targets';

function fixture(name: string): OHLCV[] {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trends', `${name}.json`), 'utf8')) as number[][]).map(([time, open, high, low, close, volume]) => ({
        time: time!,
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        volume: volume!,
    }));
}

function world() {
    const calls: string[] = [];
    const series: Record<string, OHLCV[]> = { D: fixture('SPY-D'), '240': fixture('SPY-240') };
    const bridge: Bridge = {
        id: 'yahoo',
        pollMs: 60_000,
        supports: () => true,
        async getBars(ticker, tf, req) {
            const key = tf.unit === 'day' ? 'D' : '240';
            calls.push(`${ticker} ${key}`);
            const bars = series[key]!;
            return req.limit ? bars.slice(-req.limit) : bars;
        },
    };
    const catalog = new Catalog(
        {
            groups: [{ name: 'Default', symbols: ['IDX'] }],
            instruments: {
                IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                STK: { name: 'Stock', class: 'stock', prefix: 'NYSE', yahoo: 'STK', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                COIN1: { name: 'Coin', class: 'crypto', prefix: 'CRYPTO', yahoo: 'COIN1', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
            },
        },
        { alpaca: false, finnhub: false },
    );
    const market = new MarketService(catalog, { yahoo: bridge });
    const cached = new CachedMarket(market, new CacheStore(':memory:'));
    const db = openDbAt(':memory:');
    return { db, calls, cached, market, trends: new TrendsService(db, cached) };
}

describe('trend reads', () => {
    it('loads a symbol nothing cached on demand, then answers from the stored read', async () => {
        const { calls, trends } = world();
        expect(trends.reads('IDX')).toEqual({});
        const reads = await trends.readNow('IDX');
        expect(calls.sort()).toEqual(['IDX 240', 'IDX D']);
        expect(reads.D?.shapes.length).toBeGreaterThan(0);
        expect(reads['240']?.trend.state).toBe('range');
        // Daily and 4h levels that overlap are marked on both.
        expect(reads.D!.shapes.some((s) => s.confluence)).toBe(true);
        expect(trends.reads('IDX')).toEqual(reads);
    });

    it('reads a stock from its extended-hours bars when only those are cached', async () => {
        const { trends, cached } = world();
        for (const tf of ['D', '240']) await cached.bars('STK', tf, { limit: 1000, session: 'extended' });
        expect(cached.store.series('STK|D|regular')).toBeUndefined();
        expect(trends.refresh('STK')).toBe(true);
        expect(trends.reads('STK').D?.shapes.length).toBeGreaterThan(0);
    });

    it('redoes a read only when a newer bar has settled', async () => {
        const { trends } = world();
        await trends.readNow('IDX');
        expect(trends.refresh('IDX')).toBe(false);
    });

    it('rides the passes: US-session passes take the non-crypto symbols, crypto passes the crypto ones', () => {
        const { trends, market } = world();
        const job = trendsJob(trends, market);
        const plan = { targets: [], accounts: [], watched: new Map([['IDX', 1], ['COIN1', 1]]) } as WarmPlan;
        expect(job.steps('close', plan).map((s) => s.label)).toEqual(['trends IDX']);
        expect(job.steps('crypto', plan).map((s) => s.label)).toEqual(['trends COIN1']);
        expect(job.steps('premarket', plan)).toEqual([]);
        expect(job.steps('manual', plan)).toHaveLength(2);
    });
});
