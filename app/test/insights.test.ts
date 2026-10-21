import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Metrics } from '../server/market/metrics';
import { RelatedMap } from '../server/analytics/related';
import { buildInsights, indicatorLabel, recordEvents } from '../server/analytics/insights';
import { openDbAt } from '../server/db';
import { AuthService } from '../server/auth/service';
import { SecretBox } from '../server/auth/secret-box';
import { Catalog } from '../server/market/catalog';

const related = RelatedMap.load(path.join(__dirname, '../config'));

describe('Metrics', () => {
    it('tracks calls, errors, latency percentiles and upstream headroom', () => {
        let now = Date.UTC(2026, 9, 20, 12, 0, 30);
        const m = new Metrics(() => now);
        for (let i = 1; i <= 10; i++) m.record({ bridge: 'alpaca', tag: 'bars:sip', ms: i * 10, status: 200, remaining: 200 - i, limit: 200 });
        m.record({ bridge: 'alpaca', tag: 'snapshots', ms: 500, status: 429, error: 'HTTP 429' });
        now += 1_000;
        const a = m.snapshot().bridges.find((b) => b.id === 'alpaca')!;
        expect(a.total).toBe(11);
        expect(a.errors).toBe(1);
        expect(a.throttled).toBe(1);
        expect(a.callsLastMinute).toBe(11);
        expect(a.latency.p50).toBe(60);
        expect(a.upstream).toMatchObject({ remaining: 190, limit: 200 });
        expect(a.endpoints[0]).toMatchObject({ tag: 'bars:sip', calls: 10 });
        expect(a.series).toHaveLength(60);
        expect(m.snapshot().errors[0]).toMatchObject({ bridge: 'alpaca', status: 429 });
    });
});

describe('RelatedMap', () => {
    it('keeps the shipped map closed and symmetric', () => {
        expect(related.symbols.size).toBeGreaterThan(1000);
        for (const [sym, e] of related.symbols) {
            for (const p of e.p) expect(related.symbols.has(p), `${sym} → ${p}`).toBe(true);
            for (const p of related.peersOf(sym)) expect(related.peersOf(p)).toContain(sym);
        }
    });

    it('suggests close relatives and explains why', () => {
        const s = related.suggest(new Map([['NVDA', 3], ['AMD', 2]]), new Set(), 8);
        expect(s.length).toBe(8);
        expect(s.map((x) => x.symbol)).not.toContain('NVDA');
        const top = s.slice(0, 4).map((x) => x.symbol);
        expect(top.some((t) => ['AVGO', 'TSM', 'ARM', 'MRVL', 'INTC', 'SMCI'].includes(t))).toBe(true);
        expect(s[0]!.because.length).toBeGreaterThan(0);
        expect(s[0]!.score).toBe(1);
    });

    it('follows the interest: an energy profile gets energy names', () => {
        const s = related.suggest(new Map([['OXY', 3], ['BRENT', 2], ['TTF', 1]]), new Set(), 6);
        const sectors = s.map((x) => x.sector);
        expect(sectors.filter((x) => x === 'Energy' || x === 'Commodities').length).toBeGreaterThanOrEqual(4);
    });

    it('diversifies instead of returning one cluster', () => {
        const s = related.suggest(new Map([['AAPL', 1], ['XOM', 1], ['BTCUSD', 1]]), new Set(), 9);
        expect(new Set(s.map((x) => x.sector)).size).toBeGreaterThanOrEqual(3);
    });

    it('varies the picks between visits when given a random source', () => {
        const profile = new Map([['NVDA', 3], ['AMD', 2]]);
        const symbols = (random?: () => number) => related.suggest(profile, new Set(), 12, random).map((x) => x.symbol);
        expect(symbols()).toEqual(symbols());
        const runs = [1, 2, 3, 4, 5].map((seed) => symbols(seeded(seed)));
        expect(new Set(runs.map((r) => [...r].sort().join())).size).toBeGreaterThan(1);
        expect(new Set(runs.flat()).size).toBeGreaterThan(12);
    });

    it('lets a weaker match through now and then, but rarely', () => {
        const profile = new Map([['AAPL', 2], ['MSFT', 1.5], ['NVDA', 1], ['XOM', 0.5], ['JPM', 0.5], ['SPY', 0.3]]);
        const floor = Math.min(...related.suggest(profile, new Set(), 12).map((x) => x.score)) * 0.8;
        let weaker = 0;
        let visitsWithWeaker = 0;
        for (let seed = 1; seed <= 100; seed++) {
            const n = related.suggest(profile, new Set(), 12, seeded(seed)).filter((x) => x.score < floor).length;
            weaker += n;
            if (n > 0) visitsWithWeaker += 1;
        }
        expect(visitsWithWeaker).toBeGreaterThanOrEqual(10);
        expect(weaker / (100 * 12)).toBeLessThan(0.1);
    });

    it('keeps varied picks true to the profile', () => {
        for (let seed = 1; seed <= 10; seed++) {
            const energy = related.suggest(new Map([['OXY', 3], ['BRENT', 2], ['TTF', 1]]), new Set(), 6, seeded(seed));
            expect(energy.filter((x) => x.sector === 'Energy' || x.sector === 'Commodities').length).toBeGreaterThanOrEqual(4);
            const mixed = related.suggest(new Map([['AAPL', 1], ['XOM', 1], ['BTCUSD', 1]]), new Set(), 9, seeded(seed));
            expect(new Set(mixed.map((x) => x.sector)).size).toBeGreaterThanOrEqual(3);
            const semis = related.suggest(new Map([['NVDA', 3], ['AMD', 2]]), new Set(), 8, seeded(seed));
            expect(semis.slice(0, 4).some((x) => ['AVGO', 'TSM', 'ARM', 'MRVL', 'INTC', 'SMCI'].includes(x.symbol))).toBe(true);
        }
    });
});

/** A small deterministic PRNG, so randomized picks are reproducible in tests. */
function seeded(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('analytics events and insights', () => {
    it('validates, stores and aggregates a user’s activity', async () => {
        const db = openDbAt(':memory:');
        const auth = new AuthService(db, new SecretBox('k'.repeat(40)), 86_400_000);
        const u = await auth.createUser('alice', 'correct horse battery staple', 'user');
        const now = Date.UTC(2026, 9, 20, 15, 0, 0);
        const accepted = recordEvents(
            db,
            u.id,
            [
                { k: 'open', v: 'NASDAQ:NVDA', x: '60', t: now - 3_600_000 },
                { k: 'open', v: 'NVDA', x: 'D', t: now - 86_400_000 },
                { k: 'open', v: 'AMD', x: '60', t: now },
                { k: 'watch', v: 'NVDA', x: '60', n: 5, t: now },
                { k: 'ind', v: 'rsi', t: now },
                { k: 'bogus', v: 'x' },
                { k: 'open', v: '<script>', t: now },
                { k: 'open', v: 'AAPL', t: now + 86_400_000 * 30 },
            ],
            now,
        );
        expect(accepted).toBe(6);
        const catalog = new Catalog({ groups: [], instruments: {} }, { alpaca: true, finnhub: false });
        const r = buildInsights({ db, userId: u.id, tz: 'Europe/Brussels', catalog, related, watchlist: ['SPY'], now });
        expect(r.totals.opens).toBe(4);
        expect(r.totals.minutes).toBe(5);
        expect(r.topSymbols[0]!.symbol).toBe('NVDA');
        expect(r.indicators[0]).toMatchObject({ key: 'rsi', label: 'RSI' });
        expect(r.totals.currentStreak).toBe(2);
        expect(r.suggestions.length).toBeGreaterThan(0);
        expect(r.suggestions.map((s) => s.symbol)).not.toContain('AMD');
        expect(r.suggestions.map((s) => s.symbol)).not.toContain('SPY');
        expect(r.heatmap.flat().reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
        expect(r.badges.length).toBeGreaterThan(0);
    });

    it('varies suggestions and peers between visits only when given a random source', async () => {
        const db = openDbAt(':memory:');
        const auth = new AuthService(db, new SecretBox('k'.repeat(40)), 86_400_000);
        const u = await auth.createUser('bob', 'correct horse battery staple', 'user');
        const now = Date.UTC(2026, 9, 20, 15, 0, 0);
        recordEvents(db, u.id, ['AAPL', 'MSFT', 'NVDA', 'XOM'].map((v) => ({ k: 'open', v, x: 'D', t: now })), now);
        const catalog = new Catalog({ groups: [], instruments: {} }, { alpaca: true, finnhub: false });
        const visit = (random?: () => number) => {
            const r = buildInsights({ db, userId: u.id, tz: 'Etc/UTC', catalog, related, watchlist: [], now, random });
            return { suggestions: r.suggestions.map((s) => s.symbol).sort().join(), peers: r.because.map((b) => b.peers.map((p) => p.symbol).join()).join('|') };
        };
        expect(visit()).toEqual(visit());
        const runs = [1, 2, 3, 4, 5].map((seed) => visit(seeded(seed)));
        expect(new Set(runs.map((r) => r.suggestions)).size).toBeGreaterThan(1);
        expect(new Set(runs.map((r) => r.peers)).size).toBeGreaterThan(1);
    });

    it('labels indicators readably', () => {
        expect(indicatorLabel('moving-average')).toBe('Moving Average');
        expect(indicatorLabel('bollinger-bands')).toBe('Bollinger Bands');
        expect(indicatorLabel('macd')).toBe('MACD');
    });
});
