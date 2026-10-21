import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { openDbAt } from '../server/db';
import { AuthService } from '../server/auth/service';
import { SecretBox } from '../server/auth/secret-box';
import { Catalog } from '../server/market/catalog';
import { MarketService } from '../server/market/service';
import { LiveHub } from '../server/market/live';
import { RelatedMap } from '../server/analytics/related';
import type { AppConfig } from '../server/config';
import type { Bridge, OHLCV } from '../server/market/types';
import { UpstreamError } from '../server/market/types';

const PW = 'correct horse battery staple';
const ORIGIN = 'http://charts.test';

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

/** A source that serves two bars, and fails for one ticker so fallback is observable. */
function fakeBridge(id: 'yahoo' | 'energycharts', calls: string[]): Bridge {
    return {
        id,
        pollMs: 60_000,
        supports: () => true,
        async getBars(ticker): Promise<OHLCV[]> {
            calls.push(`${id}:${ticker}`);
            if (ticker === 'BROKEN') throw new UpstreamError('down', 503);
            if (ticker === 'LIMIT') throw new UpstreamError('rate budget exhausted', 429, id === 'yahoo' ? 20_000 : 45_000);
            return [
                { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
                { time: 2, open: 1.5, high: 2.5, low: 1, close: 2, volume: 11 },
            ];
        },
        async quotes(tickers) {
            return new Map(tickers.map((t) => [t, { price: 2, prevClose: 1.6, time: 5 }]));
        },
    };
}

let app: FastifyInstance;
let auth: AuthService;
const calls: string[] = [];

beforeAll(async () => {
    const db = openDbAt(':memory:');
    auth = new AuthService(db, new SecretBox(config.sessionSecret), config.sessionTtlMs);
    await auth.createUser('alice', PW, 'user');
    await auth.createUser('root', PW, 'admin');
    const catalog = new Catalog(
        {
            groups: [{ name: 'Test', symbols: ['IDX'] }],
            instruments: {
                IDX: { name: 'Index', class: 'index', prefix: 'INDEX', yahoo: 'IDX', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                LATE: { name: 'Late', class: 'futures', prefix: 'NYMEX', yahoo: 'LATE', currency: 'USD', timezone: 'Etc/UTC', session: '24x7', delayMinutes: 10 },
                FLAKY: { name: 'Flaky', class: 'index', prefix: 'INDEX', yahoo: 'BROKEN', energycharts: 'OK', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                CAPPED: { name: 'Capped', class: 'index', prefix: 'INDEX', yahoo: 'LIMIT', energycharts: 'LIMIT', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                RESCUED: { name: 'Rescued', class: 'index', prefix: 'INDEX', yahoo: 'LIMIT', energycharts: 'OK', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
                MIXED: { name: 'Mixed', class: 'index', prefix: 'INDEX', yahoo: 'LIMIT', energycharts: 'BROKEN', currency: 'USD', timezone: 'Etc/UTC', session: '24x7' },
            },
        },
        { alpaca: false, finnhub: false },
    );
    const market = new MarketService(catalog, { yahoo: fakeBridge('yahoo', calls), energycharts: fakeBridge('energycharts', calls) });
    app = await buildApp({ config, db, auth, market, hub: new LiveHub(market), related: new RelatedMap({ symbols: {} }), logger: false });
});

afterAll(async () => {
    await app.close();
});

async function login(username: string): Promise<{ cookie: string; csrf: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, host: 'charts.test' }, payload: { username, password: PW } });
    expect(res.statusCode).toBe(200);
    const set = res.headers['set-cookie'];
    const raw = Array.isArray(set) ? set[0]! : set!;
    // Injected requests arrive over plain HTTP from loopback, like direct LAN access.
    expect(raw).toMatch(/^vela_session=/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).not.toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Lax/);
    return { cookie: raw.split(';')[0]!, csrf: res.json().csrf };
}

describe('auth gate', () => {
    it('detects HTTPS behind the proxy: __Host- cookie, Secure and HSTS only there', async () => {
        const viaProxy = { origin: 'https://charts.test', host: 'charts.test', 'x-forwarded-proto': 'https' };
        const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: viaProxy, payload: { username: 'root', password: PW } });
        expect(res.statusCode).toBe(200);
        const set = res.headers['set-cookie'];
        const raw = Array.isArray(set) ? set[0]! : set!;
        expect(raw).toMatch(/^__Host-vela_session=/);
        expect(raw).toMatch(/Secure/);
        expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
        const value = raw.split(';')[0]!.split('=')[1]!;

        const https = { host: 'charts.test', 'x-forwarded-proto': 'https' };
        expect((await app.inject({ url: '/', headers: { ...https, cookie: `__Host-vela_session=${value}` } })).statusCode).toBe(200);
        // Each scheme reads only its own cookie name.
        expect((await app.inject({ url: '/', headers: { host: 'charts.test', cookie: `__Host-vela_session=${value}` } })).statusCode).toBe(302);
        expect((await app.inject({ url: '/', headers: { ...https, cookie: `vela_session=${value}` } })).statusCode).toBe(302);
        expect((await app.inject({ url: '/', headers: { host: 'charts.test' } })).headers['strict-transport-security']).toBeUndefined();
    });

    it('refuses data routes without a session', async () => {
        expect((await app.inject({ url: '/api/bars?symbol=IDX&tf=D' })).statusCode).toBe(401);
        expect((await app.inject({ url: '/api/quotes?symbols=IDX' })).statusCode).toBe(401);
    });

    it('redirects pages to sign-in and sends security headers', async () => {
        const res = await app.inject({ url: '/' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/login');
        expect(res.headers['content-security-policy']).toContain("script-src 'self'");
        expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('refuses a cross-origin login and rate-limits guessing per account', async () => {
        const cross = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.test', host: 'charts.test' }, payload: { username: 'alice', password: PW } });
        expect(cross.statusCode).toBe(403);
        // Guess one account's password from many IPs until the per-account lock engages.
        let blockedAt = -1;
        for (let i = 0; i < 60 && blockedAt < 0; i++) {
            const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, host: 'charts.test', 'cf-connecting-ip': `203.0.113.${i}` }, payload: { username: 'victim', password: 'wrong guess' } });
            if (r.statusCode === 429) blockedAt = i;
            else expect(r.statusCode).toBe(401);
        }
        expect(blockedAt).toBeGreaterThan(0);
    });
});

describe('signed-in API', () => {
    it('serves bars and falls back to the next source when one fails', async () => {
        const { cookie } = await login('alice');
        const ok = await app.inject({ url: '/api/bars?symbol=IDX&tf=D&limit=10', headers: { cookie } });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().bars).toHaveLength(2);
        const fb = await app.inject({ url: '/api/bars?symbol=INDEX:FLAKY&tf=60', headers: { cookie } });
        expect(fb.statusCode).toBe(200);
        expect(fb.json().source).toBe('energycharts');
        expect(calls).toContain('yahoo:BROKEN');
        expect((await app.inject({ url: '/api/bars?symbol=NOPE!!&tf=D', headers: { cookie } })).statusCode).toBe(404);
    });

    it('tells the chart which symbols run late, through their symbol info', async () => {
        const { cookie } = await login('alice');
        const late = (await app.inject({ url: '/api/symbol-info?symbol=LATE', headers: { cookie } })).json();
        expect(late.delay_minutes).toBe(10);
        const live = (await app.inject({ url: '/api/symbol-info?symbol=IDX', headers: { cookie } })).json();
        expect(live).not.toHaveProperty('delay_minutes');
    });

    it('reports a rate limit that stopped every source, naming the sources and the wait', async () => {
        const { cookie } = await login('alice');
        const capped = await app.inject({ url: '/api/bars?symbol=INDEX:CAPPED&tf=60', headers: { cookie } });
        expect(capped.statusCode).toBe(429);
        expect(capped.json()).toMatchObject({ code: 'provider_limit', retryAfterSec: 20 });
        expect([...capped.json().providers].sort()).toEqual(['energycharts', 'yahoo']);
        expect(capped.headers['retry-after']).toBe('20');
        // A limited source that another one covers is not the user's problem.
        const rescued = await app.inject({ url: '/api/bars?symbol=INDEX:RESCUED&tf=60', headers: { cookie } });
        expect(rescued.statusCode).toBe(200);
        expect(rescued.json().source).toBe('energycharts');
        // A plain outage alongside the limit is reported as an outage, not blamed on the limit.
        const mixed = await app.inject({ url: '/api/bars?symbol=INDEX:MIXED&tf=60', headers: { cookie } });
        expect(mixed.statusCode).toBe(502);
        expect(mixed.json().code).toBeUndefined();
    });

    it('computes quote change from the previous close', async () => {
        const { cookie } = await login('alice');
        const q = (await app.inject({ url: '/api/quotes?symbols=IDX', headers: { cookie } })).json().quotes[0];
        expect(q).toMatchObject({ symbol: 'IDX', price: 2, prevClose: 1.6 });
        expect(q.changePct).toBeCloseTo(25);
    });

    it('requires the CSRF token and same origin for writes; storage is per user', async () => {
        const a = await login('alice');
        const r = await login('root');
        const put = (s: { cookie: string; csrf: string }, csrf: string | null, origin: string, body: string) =>
            app.inject({ method: 'PUT', url: '/api/storage/workspace', headers: { cookie: s.cookie, origin, host: 'charts.test', 'content-type': 'text/plain', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, payload: body });
        expect((await put(a, null, ORIGIN, 'x')).statusCode).toBe(403);
        expect((await put(a, a.csrf, 'https://evil.test', 'x')).statusCode).toBe(403);
        expect((await put(a, r.csrf, ORIGIN, 'x')).statusCode).toBe(403);
        expect((await put(a, a.csrf, ORIGIN, '{"mine":true}')).statusCode).toBe(200);
        expect((await app.inject({ url: '/api/storage/workspace', headers: { cookie: a.cookie } })).body).toBe('{"mine":true}');
        expect((await app.inject({ url: '/api/storage/workspace', headers: { cookie: r.cookie } })).statusCode).toBe(404);
    });

    it('keeps admin routes for admins', async () => {
        const a = await login('alice');
        expect((await app.inject({ url: '/api/admin/users', headers: { cookie: a.cookie } })).statusCode).toBe(403);
        const r = await login('root');
        const res = await app.inject({ url: '/api/admin/users', headers: { cookie: r.cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.json().users.map((u: { username: string }) => u.username)).toEqual(['alice', 'root']);
        expect(JSON.stringify(res.json())).not.toContain('argon2');
    });

    it('accepts analytics events and serves the user insights and provider stats', async () => {
        const a = await login('alice');
        const post = await app.inject({ method: 'POST', url: '/api/analytics/events', headers: { cookie: a.cookie, origin: ORIGIN, host: 'charts.test', 'x-csrf-token': a.csrf }, payload: { events: [{ k: 'open', v: 'INDEX:IDX', x: 'D', t: Date.now() }] } });
        expect(post.json()).toEqual({ accepted: 1 });
        const me = await app.inject({ url: '/api/analytics/me?tz=Europe/Brussels', headers: { cookie: a.cookie } });
        expect(me.statusCode).toBe(200);
        expect(me.json().topSymbols[0].symbol).toBe('IDX');
        const r = await login('root');
        expect((await app.inject({ url: '/api/analytics/me', headers: { cookie: r.cookie } })).json().totals.opens).toBe(0);
        const stats = await app.inject({ url: '/api/insights/providers', headers: { cookie: a.cookie } });
        expect(stats.statusCode).toBe(200);
        expect(stats.json().bridges.map((b: { id: string }) => b.id)).toEqual(['alpaca', 'finnhub', 'yahoo', 'energycharts', 'coinbase']);
        expect((await app.inject({ url: '/api/insights/providers' })).statusCode).toBe(401);
    });

    it('signing out invalidates the session', async () => {
        const a = await login('alice');
        const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: a.cookie, origin: ORIGIN, host: 'charts.test', 'x-csrf-token': a.csrf }, payload: {} });
        expect(out.statusCode).toBe(200);
        expect((await app.inject({ url: '/api/auth/me', headers: { cookie: a.cookie } })).statusCode).toBe(401);
    });
});
