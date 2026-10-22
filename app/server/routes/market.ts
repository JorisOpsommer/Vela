// Market data for the browser: one origin, behind the session, so API keys never leave
// the server and the upstream quotas are spent only by signed-in users.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { ProviderLimitError, UpstreamError, type CatalogEntry } from '../market/types';
import { sameOrigin } from '../security';
import { ENERGY_ATTRIBUTION } from '../market/bridges/energycharts';
import { ledgerCryptoIconUrl } from '../../../src/data/symbol-base';
import { runAsUpkeep } from '../market/background';

const MAX_SUBS_PER_SOCKET = 64;
const LOGO_TTL_MS = 30 * 86_400_000;
const LOGO_MISS_TTL_MS = 7 * 86_400_000;
const MAX_LOGO_BYTES = 256 * 1024;

function num(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function decimalsOf(e: CatalogEntry): number {
    if (e.decimals != null) return e.decimals;
    if (e.class === 'forex') return 5;
    return 2;
}

export function symbolInfo(e: CatalogEntry, extended: string | undefined) {
    const decimals = decimalsOf(e);
    const mintick = 1 / 10 ** decimals;
    return {
        ticker: e.symbol,
        tickerid: `${e.prefix}:${e.symbol}`,
        prefix: e.prefix,
        description: e.name,
        type: e.class,
        currency: e.currency,
        mintick,
        pricescale: 10 ** decimals,
        timezone: e.timezone,
        session: e.session,
        ...(extended ? { session_extended: extended } : {}),
        ...(e.class === 'power' ? { attribution: ENERGY_ATTRIBUTION } : {}),
        // The chart's status line shows a "Delayed Nm" tag for this.
        ...(e.delayMinutes ? { delay_minutes: e.delayMinutes } : {}),
    };
}

export function registerMarketRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { market, hub, db, cached } = ctx;

    let symbolsJson: { body: string; etag: string; at: number } | null = null;
    app.get('/api/symbols', async (req, reply) => {
        if (!symbolsJson || Date.now() - symbolsJson.at > 3_600_000) {
            const rows = market.catalog.all().map((e) => ({ ticker: e.symbol, description: e.name, type: e.class, prefix: e.prefix }));
            const body = JSON.stringify(rows);
            symbolsJson = { body, etag: `"s${rows.length}-${body.length}"`, at: Date.now() };
        }
        // Revalidate every load (a 304 when unchanged), so an update reaches browsers at once.
        reply.header('ETag', symbolsJson.etag).header('Cache-Control', 'private, no-cache');
        if (req.headers['if-none-match'] === symbolsJson.etag) return reply.code(304).send();
        return reply.type('application/json').send(symbolsJson.body);
    });

    app.get('/api/watchlist/defaults', async () => ({ groups: market.catalog.defaultGroups() }));

    app.get('/api/symbol-info', async (req, reply) => {
        const e = market.resolve(String((req.query as { symbol?: string }).symbol ?? ''));
        if (!e) return reply.code(404).send({ error: 'Unknown symbol.' });
        return symbolInfo(e, market.catalog.sessionExtended(e));
    });

    app.get('/api/bars', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const limit = num(q.limit);
        const req2 = {
            from: num(q.from),
            to: num(q.to),
            limit: limit != null ? Math.min(Math.max(1, Math.floor(limit)), 5000) : undefined,
            session: q.session === 'extended' ? 'extended' : 'regular',
        };
        // `cache=only`: what the server already holds, at once and without a provider call —
        // the chart paints it while the full answer is on its way.
        if (q.cache === 'only') {
            const peek = await cached.peek(String(q.symbol ?? ''), String(q.tf ?? 'D'), req2);
            return peek ?? { bars: [], asOf: null, complete: false };
        }
        // Opening a chart or scrolling back (no `from`) is someone charting; a `from`-only
        // request refreshes the newest bars of a chart already on screen — upkeep.
        const load = () => cached.bars(String(q.symbol ?? ''), String(q.tf ?? 'D'), req2);
        try {
            const { bars, source, cache } = req2.from != null && req2.to == null ? await runAsUpkeep(load) : await load();
            return { bars, source, cache };
        } catch (err) {
            req.log.warn({ symbol: q.symbol, tf: q.tf, err: (err as Error).message }, 'bars failed');
            if (err instanceof ProviderLimitError) {
                const retryAfterSec = Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 1000));
                return reply.code(429).header('Retry-After', String(retryAfterSec)).send({ error: err.message, code: 'provider_limit', providers: err.providers, retryAfterSec });
            }
            const status = err instanceof UpstreamError && err.status && err.status < 500 && err.status !== 429 ? err.status : 502;
            return reply.code(status).send({ error: (err as Error).message });
        }
    });

    app.get('/api/quotes', async (req, reply) => {
        const raw = String((req.query as { symbols?: string }).symbols ?? '');
        const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 120);
        if (symbols.length === 0) return reply.code(400).send({ error: 'symbols required' });
        if ((req.query as { cache?: string }).cache === 'only') return { quotes: cached.peekQuotes(symbols) };
        // Watchlist prices refresh on a timer whether anyone looks or not: upkeep.
        return { quotes: await runAsUpkeep(() => cached.quotes(symbols)) };
    });

    app.get('/api/calendar', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const from = num(q.from) ?? Date.now() - 7 * 86_400_000;
        const to = num(q.to) ?? Date.now() + 7 * 86_400_000;
        if (to - from > 400 * 86_400_000) return reply.code(400).send({ error: 'range too large' });
        try {
            return { windows: await market.calendar(String(q.symbol ?? ''), from, to, q.session === 'extended' ? 'extended' : 'regular') };
        } catch (err) {
            return reply.code(502).send({ error: (err as Error).message });
        }
    });

    app.get('/api/status', async () => ({ bridges: market.status(), live: hub.stats(), tradeStream: market.bridges.finnhub?.stats() ?? null }));

    app.get('/api/logo/:symbol', async (req, reply) => {
        const e = market.resolve((req.params as { symbol: string }).symbol);
        if (!e) return reply.code(404).send();
        const row = db.prepare('SELECT content_type, body, fetched_at FROM logo_cache WHERE symbol = ?').get(e.symbol) as { content_type: string | null; body: Uint8Array | null; fetched_at: number } | undefined;
        const fresh = row && Date.now() - row.fetched_at < (row.body ? LOGO_TTL_MS : LOGO_MISS_TTL_MS);
        let hit = fresh ? row : undefined;
        if (!hit) {
            let fetched: { type: string; body: Buffer } | null;
            try {
                fetched = await fetchLogo(e, ctx);
            } catch {
                // Lookup failed (not "no logo"): answer without caching the miss.
                return reply.code(404).header('Cache-Control', 'no-store').send();
            }
            db.prepare('INSERT INTO logo_cache (symbol, content_type, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET content_type = excluded.content_type, body = excluded.body, fetched_at = excluded.fetched_at').run(
                e.symbol,
                fetched?.type ?? null,
                fetched?.body ?? null,
                Date.now(),
            );
            hit = { content_type: fetched?.type ?? null, body: fetched?.body ?? null, fetched_at: Date.now() };
        }
        if (!hit.body || !hit.content_type) return reply.code(404).header('Cache-Control', 'private, max-age=86400').send();
        return reply.type(hit.content_type).header('Cache-Control', 'private, max-age=604800').send(Buffer.from(hit.body));
    });

    app.get('/api/stream', { websocket: true }, (socket, req) => {
        if (!sameOrigin(req)) {
            socket.close(1008, 'origin');
            return;
        }
        const subs = new Map<number, () => void>();
        // Keepalive: proxies drop sockets that stay silent (a power chart updates every 15 min).
        const ping = setInterval(() => {
            if (socket.readyState === socket.OPEN) socket.ping();
        }, 30_000);
        const send = (msg: object) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
        };
        socket.on('message', (raw: Buffer) => {
            let msg: { op?: string; id?: unknown; symbol?: unknown; tf?: unknown; session?: unknown };
            try {
                msg = JSON.parse(raw.toString('utf8'));
            } catch {
                return;
            }
            const id = typeof msg.id === 'number' && Number.isInteger(msg.id) ? msg.id : null;
            if (id == null) return;
            if (msg.op === 'unsub') {
                subs.get(id)?.();
                subs.delete(id);
                return;
            }
            if (msg.op !== 'sub' || typeof msg.symbol !== 'string' || typeof msg.tf !== 'string') return;
            if (subs.size >= MAX_SUBS_PER_SOCKET) return send({ op: 'error', id, error: 'too many subscriptions' });
            subs.get(id)?.();
            try {
                const stop = hub.subscribe(msg.symbol, msg.tf, typeof msg.session === 'string' ? msg.session : undefined, (bar) => send({ op: 'bar', id, bar }));
                subs.set(id, stop);
            } catch (err) {
                send({ op: 'error', id, error: (err as Error).message });
            }
        });
        socket.on('close', () => {
            clearInterval(ping);
            for (const stop of subs.values()) stop();
            subs.clear();
        });
    });
}

async function fetchLogo(e: CatalogEntry, ctx: AppContext): Promise<{ type: string; body: Buffer } | null> {
    let url: string | null | undefined = null;
    if (e.class === 'crypto') url = ledgerCryptoIconUrl(e.symbol.replace(/(USD|BTC|EUR|USDT)$/, '') || e.symbol);
    else if (e.class === 'stock' || e.class === 'etf') url = await ctx.market.bridges.finnhub?.logoUrl(e.symbol);
    if (!url || !url.startsWith('https://')) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.url.startsWith('https://')) return null;
    if (res.status >= 500 || res.status === 429) throw new Error(`logo host ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpeg|webp|gif|svg\+xml)/.test(type)) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0 || body.length > MAX_LOGO_BYTES) return null;
    // SVG can carry script; only raster images are relayed.
    if (type.startsWith('image/svg')) return null;
    return { type: type.split(';')[0]!, body };
}
