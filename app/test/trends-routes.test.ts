// The copy inbox behind the trends page: copies append, the chart app claims what it placed,
// and only boxes and trend lines get in.
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { CachedMarket } from '../server/market/cached-market';
import { CacheStore } from '../server/market/cache-store';
import { openDbAt } from '../server/db';
import { AuthService } from '../server/auth/service';
import { SecretBox } from '../server/auth/secret-box';
import { Catalog } from '../server/market/catalog';
import { MarketService } from '../server/market/service';
import { LiveHub } from '../server/market/live';
import { RelatedMap } from '../server/analytics/related';
import { TrendsService } from '../server/trends/service';
import type { AppConfig } from '../server/config';
import type { Bridge } from '../server/market/types';

const PW = 'correct horse battery staple';
const HEADERS = { origin: 'http://charts.test', host: 'charts.test' };

const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '/nonexistent',
    webDir: '/nonexistent',
    configDir: '/nonexistent',
    sessionSecret: 's'.repeat(40),
    sessionTtlMs: 86_400_000,
    admin: null,
    finnhubKey: null,
    alpaca: null,
};

let app: FastifyInstance;

beforeAll(async () => {
    const db = openDbAt(':memory:');
    const auth = new AuthService(db, new SecretBox(config.sessionSecret), config.sessionTtlMs);
    await auth.createUser('alice', PW, 'user');
    const bridge: Bridge = { id: 'yahoo', pollMs: 60_000, supports: () => true, getBars: async () => [] };
    const catalog = new Catalog(
        { groups: [{ name: 'Test', symbols: ['IDX'] }], instruments: { IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' } } },
        { alpaca: false, finnhub: false },
    );
    const market = new MarketService(catalog, { yahoo: bridge });
    const cached = new CachedMarket(market, new CacheStore(':memory:'));
    app = await buildApp({ config, db, auth, market, hub: new LiveHub(market), cached, related: new RelatedMap({ symbols: {} }), trends: new TrendsService(db, cached), logger: false });
});

async function login(): Promise<Record<string, string>> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: HEADERS, payload: { username: 'alice', password: PW } });
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as string | string[])[0]!;
    return { ...HEADERS, cookie: raw.split(';')[0]!, 'x-csrf-token': res.json().csrf };
}

const box = (price: number) => ({ type: 'box', anchors: [{ time: 1, price: price + 1 }, { time: 2, price }], style: { lineColor: '#22ab94', lineWidth: 1, lineStyle: 'solid' }, showOn: ['D'] });

describe('the copy inbox', () => {
    it('takes boxes and trend lines only, with CSRF', async () => {
        const h = await login();
        const { 'x-csrf-token': _csrf, ...noCsrf } = h;
        expect((await app.inject({ method: 'POST', url: '/api/trends/copy', headers: noCsrf, payload: { symbol: 'IDX', shapes: [{ shapeId: 'a', drawing: box(1) }] } })).statusCode).toBe(403);
        const bad = await app.inject({ method: 'POST', url: '/api/trends/copy', headers: h, payload: { symbol: 'IDX', shapes: [{ shapeId: 'a', drawing: { type: 'freehand', anchors: [] } }] } });
        expect(bad.statusCode).toBe(400);
        const nan = await app.inject({ method: 'POST', url: '/api/trends/copy', headers: h, payload: { symbol: 'IDX', shapes: [{ shapeId: 'a', drawing: { ...box(1), anchors: [{ time: 'x', price: 1 }, { time: 2, price: 1 }] } }] } });
        expect(nan.statusCode).toBe(400);
    });

    it('appends copies, marks them copied for the trends page, and lets the chart app claim them', async () => {
        const h = await login();
        const first = await app.inject({ method: 'POST', url: '/api/trends/copy', headers: h, payload: { symbol: 'IDX', shapes: [{ shapeId: 'D-level-1', drawing: box(10) }] } });
        expect(first.json()).toEqual({ ok: true, waiting: 1 });
        const second = await app.inject({ method: 'POST', url: '/api/trends/copy', headers: h, payload: { symbol: 'INDEX:IDX', shapes: [{ shapeId: 'D-level-2', drawing: box(20) }] } });
        expect(second.json()).toEqual({ ok: true, waiting: 2 });

        const inbox = JSON.parse((await app.inject({ url: '/api/storage/drawing-inbox', headers: h })).body) as { items: Array<{ id: string; symbol: string; drawing: { anchors: Array<{ price: number }>; showOn?: string[] } }> };
        expect(inbox.items.map((i) => [i.symbol, i.drawing.anchors[1]!.price])).toEqual([
            ['IDX', 10],
            ['IDX', 20],
        ]);
        expect(inbox.items[0]!.drawing.showOn).toEqual(['D']);
        const view = await app.inject({ url: '/api/trends/symbol/IDX', headers: h });
        expect(view.json().copied.sort()).toEqual(['D-level-1', 'D-level-2']);

        const claim = await app.inject({ method: 'POST', url: '/api/trends/inbox/claim', headers: h, payload: { ids: [inbox.items[0]!.id] } });
        expect(claim.json()).toEqual({ ok: true, remaining: 1 });
        const after = JSON.parse((await app.inject({ url: '/api/storage/drawing-inbox', headers: h })).body) as { items: Array<{ drawing: { anchors: Array<{ price: number }> } }> };
        expect(after.items.map((i) => i.drawing.anchors[1]!.price)).toEqual([20]);
        // Claiming keeps the copied marks: the trends page still shows them as copied.
        expect((await app.inject({ url: '/api/trends/symbol/IDX', headers: h })).json().copied).toHaveLength(2);
    });
});
