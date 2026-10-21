// Provider statistics and the user's own analytics.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { metrics } from '../market/metrics';
import { buildInsights, clearEvents, recordEvents } from '../analytics/insights';
import { bareSymbol } from '../market/catalog';

/** The upstream's published per-minute limit, where one exists (our own budget otherwise). */
const PUBLISHED_LIMITS: Record<string, { perMinute: number | null; note: string }> = {
    alpaca: { perMinute: 200, note: 'Basic plan: 200 requests/min' },
    finnhub: { perMinute: 60, note: 'Free plan: 60 requests/min, 50 streamed symbols' },
    yahoo: { perMinute: null, note: 'Unofficial endpoint — no published limit' },
    energycharts: { perMinute: null, note: 'Public API — no published limit' },
    coinbase: { perMinute: 600, note: 'Public market data: ~10 requests/s' },
};

function isValidZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function registerInsightRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { market, hub, db } = ctx;

    app.get('/api/insights/providers', async () => {
        const snap = metrics.snapshot();
        const health = market.status();
        const finnhub = market.bridges.finnhub?.stats() ?? null;
        return {
            ...snap,
            bridges: snap.bridges.map((b) => ({ ...b, configured: health[b.id]?.configured ?? false, healthy: health[b.id]?.healthy ?? false, published: PUBLISHED_LIMITS[b.id] })),
            live: { ...hub.stats(), tradeStream: finnhub },
        };
    });

    app.post('/api/analytics/events', async (req) => {
        const body = (req.body ?? {}) as { events?: unknown };
        return { accepted: recordEvents(db, req.session!.user.id, body.events) };
    });

    app.get('/api/analytics/me', async (req) => {
        const q = req.query as { tz?: string };
        const tz = typeof q.tz === 'string' && q.tz.length < 64 && isValidZone(q.tz) ? q.tz : 'Etc/UTC';
        const userId = req.session!.user.id;
        const row = db.prepare("SELECT value FROM user_storage WHERE user_id = ? AND key = 'watchlist'").get(userId) as { value: string } | undefined;
        let watchlist: string[] = [];
        try {
            const doc = row ? (JSON.parse(row.value) as { groups?: Array<{ symbols?: unknown[] }> }) : null;
            watchlist = (doc?.groups ?? []).flatMap((g) => (Array.isArray(g.symbols) ? g.symbols : [])).filter((s): s is string => typeof s === 'string').map(bareSymbol);
        } catch {
            // A malformed watchlist simply contributes nothing.
        }
        if (watchlist.length === 0) watchlist = market.catalog.defaultGroups().flatMap((g) => g.symbols);
        return buildInsights({ db, userId, tz, catalog: market.catalog, related: ctx.related, watchlist, random: Math.random });
    });

    app.delete('/api/analytics/me', async (req) => {
        clearEvents(db, req.session!.user.id);
        return { ok: true };
    });
}
