// The options page: the account's watchlist at a glance, and one symbol in depth. A
// symbol without a read for the current trading day is read on demand.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { accountWatchlist } from '../analytics/userbase';
import { UpstreamError } from '../market/types';
import { ivRank, type OptionsRead } from '../options/service';

export function registerOptionsRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { db, market, options } = ctx;
    if (!options) return;

    app.get('/api/options/watchlist', async (req) => {
        const symbols = accountWatchlist(db, market.catalog, req.session!.user.id);
        const rows = [];
        for (const symbol of symbols) {
            const entry = market.resolve(symbol);
            if (!entry || (entry.class !== 'stock' && entry.class !== 'etf')) continue;
            const days = options.history(symbol);
            const [today, prev] = days;
            rows.push({
                symbol,
                name: entry.name,
                summary: today?.summary ?? null,
                previous: prev?.summary ?? null,
                ivRank: ivRank(days),
                terms: await options.assetTerms(symbol),
            });
        }
        return { available: options.available, rows };
    });

    app.get('/api/options/symbol/:symbol', async (req, reply) => {
        const { symbol: raw } = req.params as { symbol: string };
        const entry = market.resolve(raw);
        if (!entry) return reply.code(400).send({ error: 'Unknown symbol.' });
        if (!options.available) return reply.code(409).send({ error: 'Options data needs the Alpaca keys.' });
        const date = await options.sessionDate();
        let read: OptionsRead | null = options.latest(entry.symbol);
        if (!read || read.summary.date !== date) {
            try {
                read = await options.read(entry.symbol);
            } catch (err) {
                // A stored read from an earlier day still beats nothing.
                if (!read) {
                    const status = err instanceof UpstreamError && err.status && err.status < 500 && err.status !== 429 ? err.status : 502;
                    return reply.code(status).send({ error: (err as Error).message });
                }
            }
        }
        const days = options.history(entry.symbol);
        const previous = days.find((d) => d.date < read!.summary.date) ?? null;
        return {
            symbol: entry.symbol,
            name: entry.name,
            read,
            previousStrikes: previous?.strikes ?? null,
            previousDate: previous?.date ?? null,
            history: days.map((d) => ({ date: d.date, spot: d.summary.spot, callOI: d.summary.callOI, putOI: d.summary.putOI, pcrOI: d.summary.pcrOI, iv30: d.summary.iv30 })).reverse(),
            ivRank: ivRank(days),
            terms: await options.assetTerms(entry.symbol),
        };
    });
}
