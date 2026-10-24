// Composition of the HTTP server: security headers, session resolution, CSRF, and the
// route modules. Built from injected dependencies so tests drive it with fakes.
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import type { Db } from './db';
import type { AuthService, Session } from './auth/service';
import type { MarketService } from './market/service';
import type { LiveHub } from './market/live';
import type { CachedMarket } from './market/cached-market';
import type { CacheWarmer } from './market/warmer';
import type { RelatedMap } from './analytics/related';
import type { OptionsService } from './options/service';
import type { TrendsService } from './trends/service';
import { applySecurityHeaders, clientIp, isHttps, sameOrigin } from './security';
import { FailureLimiter, WindowCounter } from './auth/rate-limit';
import { registerAuthRoutes } from './routes/auth';
import { registerAdminRoutes } from './routes/admin';
import { registerStorageRoutes } from './routes/storage';
import { registerMarketRoutes } from './routes/market';
import { registerInsightRoutes } from './routes/insights';
import { registerCacheRoutes } from './routes/cache';
import { registerOptionsRoutes } from './routes/options';
import { registerTrendRoutes } from './routes/trends';

declare module 'fastify' {
    interface FastifyRequest {
        session: Session | null;
        sessionToken: string | undefined;
        clientIp: string;
        /** Reached over HTTPS (directly or via the proxy) — picks the cookie flavour. */
        isHttps: boolean;
    }
}

export interface AppDeps {
    config: AppConfig;
    db: Db;
    auth: AuthService;
    market: MarketService;
    hub: LiveHub;
    cached: CachedMarket;
    /** Absent in tests that do not exercise background warming. */
    warmer?: CacheWarmer;
    related: RelatedMap;
    /** Absent in tests that do not exercise the options page. */
    options?: OptionsService;
    /** Absent in tests that do not exercise the trends page. */
    trends?: TrendsService;
    logger?: boolean;
}

export interface AppContext extends AppDeps {
    setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void;
    clearSessionCookie(reply: FastifyReply): void;
    loginLimiterIp: FailureLimiter;
    loginLimiterUser: FailureLimiter;
}

/** Paths reachable without a session. */
const PUBLIC_API = new Set(['/api/auth/login', '/api/health']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
    const { config } = deps;
    const app = Fastify({
        logger: deps.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]'] },
        bodyLimit: 4 * 1024 * 1024,
        trustProxy: false,
        // Per-request lines would drown the log in chart polling; routes log what matters.
        logController: new LogController({ disableRequestLogging: true }),
    });

    // Over HTTPS the `__Host-` prefix pins the cookie to this exact origin and requires
    // `Secure`; plain HTTP (LAN access) cannot carry either, so it gets a plain cookie. Each
    // scheme reads only its own name, so a cookie planted over HTTP never counts on HTTPS.
    const cookieName = (secure: boolean) => (secure ? '__Host-vela_session' : 'vela_session');
    const ctx: AppContext = {
        ...deps,
        setSessionCookie(reply, token, expiresAt) {
            const secure = reply.request.isHttps;
            reply.setCookie(cookieName(secure), token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: new Date(expiresAt) });
        },
        clearSessionCookie(reply) {
            const secure = reply.request.isHttps;
            reply.clearCookie(cookieName(secure), { httpOnly: true, secure, sameSite: 'lax', path: '/' });
        },
        loginLimiterIp: new FailureLimiter({ maxFailures: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000, maxLockMs: 24 * 3_600_000 }),
        loginLimiterUser: new FailureLimiter({ maxFailures: 25, windowMs: 15 * 60_000, lockMs: 5 * 60_000, maxLockMs: 3_600_000 }),
    };

    await app.register(cookie);
    await app.register(compress, { global: true, threshold: 2048, encodings: ['br', 'gzip'] });
    await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

    app.decorateRequest('session', null);
    app.decorateRequest('sessionToken', undefined);
    app.decorateRequest('clientIp', '');
    app.decorateRequest('isHttps', false);

    const apiBudget = new WindowCounter(900, 60_000);

    app.addHook('onRequest', async (req, reply) => {
        req.isHttps = isHttps(req);
        applySecurityHeaders(reply, req.isHttps);
        req.clientIp = clientIp(req);
        req.sessionToken = req.cookies[cookieName(req.isHttps)];
        req.session = deps.auth.getSession(req.sessionToken);
        if (req.session?.refreshed && req.sessionToken) ctx.setSessionCookie(reply, req.sessionToken, req.session.expiresAt);

        const url = req.url.split('?')[0]!;
        if (!url.startsWith('/api/')) return;
        reply.header('Cache-Control', 'no-store');
        if (PUBLIC_API.has(url)) {
            if (!SAFE_METHODS.has(req.method) && !sameOrigin(req)) return reply.code(403).send({ error: 'Cross-origin request refused.' });
            return;
        }
        if (!req.session) return reply.code(401).send({ error: 'Not signed in.' });
        if (!apiBudget.hit(`u${req.session.user.id}`)) return reply.code(429).send({ error: 'Too many requests.' });
        if (!SAFE_METHODS.has(req.method)) {
            const token = req.headers['x-csrf-token'];
            if (typeof token !== 'string' || token !== req.session.csrf || !sameOrigin(req)) {
                return reply.code(403).send({ error: 'Invalid CSRF token.' });
            }
        }
        // A reset password must be replaced before anything else.
        if (req.session.user.mustChangePassword && !url.startsWith('/api/auth/'))
            return reply.code(403).send({ error: 'Password change required.', mustChangePassword: true });
        if (url.startsWith('/api/admin/') && req.session.user.role !== 'admin') return reply.code(403).send({ error: 'Admins only.' });
    });

    app.get('/api/health', async () => ({ ok: true }));

    registerAuthRoutes(app, ctx);
    registerAdminRoutes(app, ctx);
    registerStorageRoutes(app, ctx);
    registerMarketRoutes(app, ctx);
    registerInsightRoutes(app, ctx);
    registerCacheRoutes(app, ctx);
    registerOptionsRoutes(app, ctx);
    registerTrendRoutes(app, ctx);

    // ── Pages ──────────────────────────────────────────────────────────────
    const webDir = config.webDir;
    const page = (name: string) => {
        const file = path.join(webDir, name);
        return fs.existsSync(file)
            ? fs.readFileSync(file, 'utf8')
            : `<!doctype html><title>Missing build</title><p>Run <code>npm run build</code> (missing ${name}).`;
    };
    const sendPage = (reply: FastifyReply, name: string) => reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page(name));
    const requireSession = (req: FastifyRequest, reply: FastifyReply, name: string) => {
        if (!req.session) return reply.redirect('/login');
        if (req.session.user.mustChangePassword && name !== 'account.html') return reply.redirect('/account');
        return sendPage(reply, name);
    };

    app.get('/', (req, reply) => requireSession(req, reply, 'index.html'));
    app.get('/account', (req, reply) => requireSession(req, reply, 'account.html'));
    app.get('/stats', (req, reply) => requireSession(req, reply, 'stats.html'));
    app.get('/insights', (req, reply) => requireSession(req, reply, 'insights.html'));
    app.get('/cache', (req, reply) => requireSession(req, reply, 'cache.html'));
    app.get('/options', (req, reply) => requireSession(req, reply, 'options.html'));
    app.get('/trends', (req, reply) => requireSession(req, reply, 'trends.html'));
    app.get('/login', (req, reply) => (req.session ? reply.redirect('/') : sendPage(reply, 'login.html')));

    if (fs.existsSync(path.join(webDir, 'assets'))) {
        await app.register(fastifyStatic, {
            root: path.join(webDir, 'assets'),
            prefix: '/assets/',
            index: false,
            immutable: true,
            maxAge: '365d',
        });
    }
    app.get('/favicon.svg', (_req, reply) => {
        const f = path.join(webDir, 'favicon.svg');
        if (!fs.existsSync(f)) return reply.code(404).send();
        return reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=86400').send(fs.readFileSync(f));
    });

    app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
        return reply.code(404).type('text/plain').send('Not found');
    });
    app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
        const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
        if (status >= 500) req.log.error({ err }, 'request failed');
        return reply.code(status).send({ error: status >= 500 ? 'Internal error.' : err.message });
    });

    return app;
}
