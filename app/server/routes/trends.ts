// The trends page: the account's watchlist with what the detector sees on each symbol, and
// one symbol's shapes. A symbol without a read is detected on demand.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { accountWatchlist } from '../analytics/userbase';
import type { Detection, TrendSignal } from '../trends/detect';

/** The per-account document copied shapes wait in until the chart app places them. */
export const INBOX_KEY = 'drawing-inbox';
const INBOX_MAX_ITEMS = 200;
const COPIED_MAX = 2_000;
const COPYABLE = new Set(['box', 'trendline']);

export interface InboxItem {
    id: string;
    /** Canonical symbol the drawing belongs to. */
    symbol: string;
    drawing: Record<string, unknown>;
    at: number;
}

export interface InboxDoc {
    version: 1;
    items: InboxItem[];
    /** `SYMBOL|shapeId` → when it was copied, so the trends page can mark it. */
    copied: Record<string, number>;
}

export function parseInbox(raw: string | undefined): InboxDoc {
    try {
        const d = raw ? (JSON.parse(raw) as Partial<InboxDoc>) : null;
        if (d?.version === 1 && Array.isArray(d.items) && d.copied && typeof d.copied === 'object') return { version: 1, items: d.items, copied: d.copied };
    } catch {
        // An unreadable inbox starts over: it only ever holds copies the trends page can redo.
    }
    return { version: 1, items: [], copied: {} };
}

/** A copied drawing as the chart may take it: a box or trend line with two finite anchors. */
function cleanDrawing(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    if (typeof d.type !== 'string' || !COPYABLE.has(d.type) || !Array.isArray(d.anchors) || d.anchors.length !== 2) return null;
    const anchors = (d.anchors as Array<{ time?: unknown; price?: unknown }>).map((a) => ({ time: Number(a?.time), price: Number(a?.price) }));
    if (anchors.some((a) => !Number.isFinite(a.time) || !Number.isFinite(a.price))) return null;
    const out: Record<string, unknown> = { type: d.type, anchors };
    for (const k of ['style', 'text', 'props']) if (d[k] && typeof d[k] === 'object') out[k] = d[k];
    if (Array.isArray(d.showOn)) out.showOn = d.showOn.filter((x) => typeof x === 'string');
    return out;
}

/** One timeframe of a watchlist row: the trend and the strongest signal, without the shapes. */
function brief(d: Detection | undefined) {
    if (!d) return null;
    return { asOf: d.asOf, close: d.close, trend: d.trend, shapes: d.shapes.length, signal: d.signals[0] ?? null };
}

export function registerTrendRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { db, market, trends } = ctx;
    if (!trends) return;

    // The inbox is read-modify-written here in one synchronous step, so a copy and a claim
    // racing from two tabs never lose each other's change.
    const readInbox = (userId: number) => parseInbox((db.prepare('SELECT value FROM user_storage WHERE user_id = ? AND key = ?').get(userId, INBOX_KEY) as { value: string } | undefined)?.value);
    const writeInbox = (userId: number, doc: InboxDoc) => {
        const cur = db.prepare('SELECT updated_at FROM user_storage WHERE user_id = ? AND key = ?').get(userId, INBOX_KEY) as { updated_at: number } | undefined;
        const revision = Math.max(Date.now(), (cur?.updated_at ?? 0) + 1);
        db.prepare('INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(userId, INBOX_KEY, JSON.stringify(doc), revision);
    };

    app.get('/api/trends', async (req) => {
        const rows = accountWatchlist(db, market.catalog, req.session!.user.id).map((symbol) => {
            const entry = market.resolve(symbol);
            const reads = trends.reads(symbol);
            const signals: TrendSignal[] = [...(reads.W?.signals ?? []), ...(reads.D?.signals ?? []), ...(reads['240']?.signals ?? [])].sort((a, b) => b.strength - a.strength);
            return { symbol, name: entry?.name ?? symbol, class: entry?.class ?? null, W: brief(reads.W), D: brief(reads.D), h4: brief(reads['240']), top: signals[0] ?? null };
        });
        return { rows };
    });

    app.get('/api/trends/symbol/:symbol', async (req, reply) => {
        const { symbol: raw } = req.params as { symbol: string };
        const entry = market.resolve(raw);
        if (!entry) return reply.code(400).send({ error: 'Unknown symbol.' });
        let reads = trends.reads(entry.symbol);
        if (!reads.W || !reads.D || !reads['240']) reads = await trends.readNow(entry.symbol);
        const copied = Object.keys(readInbox(req.session!.user.id).copied)
            .filter((k) => k.startsWith(`${entry.symbol}|`))
            .map((k) => k.slice(entry.symbol.length + 1));
        return { symbol: entry.symbol, name: entry.name, class: entry.class, reads, copied };
    });

    app.post('/api/trends/copy', async (req, reply) => {
        const body = (req.body ?? {}) as { symbol?: unknown; shapes?: unknown };
        const entry = typeof body.symbol === 'string' ? market.resolve(body.symbol) : null;
        if (!entry || !Array.isArray(body.shapes) || body.shapes.length === 0 || body.shapes.length > 40) return reply.code(400).send({ error: 'Nothing to copy.' });
        const shapes = (body.shapes as Array<{ shapeId?: unknown; drawing?: unknown }>).map((x) => ({ shapeId: typeof x?.shapeId === 'string' ? x.shapeId.slice(0, 120) : null, drawing: cleanDrawing(x?.drawing) }));
        if (shapes.some((x) => !x.drawing)) return reply.code(400).send({ error: 'Only boxes and trend lines can be copied.' });
        const userId = req.session!.user.id;
        const doc = readInbox(userId);
        const at = Date.now();
        for (const x of shapes) {
            doc.items.push({ id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, symbol: entry.symbol, drawing: x.drawing!, at });
            if (x.shapeId) doc.copied[`${entry.symbol}|${x.shapeId}`] = at;
        }
        // Oldest copies first out: an inbox nobody drains stays bounded.
        if (doc.items.length > INBOX_MAX_ITEMS) doc.items.splice(0, doc.items.length - INBOX_MAX_ITEMS);
        const marks = Object.entries(doc.copied);
        if (marks.length > COPIED_MAX) doc.copied = Object.fromEntries(marks.sort((a, b) => b[1] - a[1]).slice(0, COPIED_MAX));
        writeInbox(userId, doc);
        return { ok: true, waiting: doc.items.filter((i) => i.symbol === entry.symbol).length };
    });

    app.post('/api/trends/inbox/claim', async (req, reply) => {
        const ids = (req.body as { ids?: unknown } | undefined)?.ids;
        if (!Array.isArray(ids)) return reply.code(400).send({ error: 'No ids.' });
        const userId = req.session!.user.id;
        const doc = readInbox(userId);
        const claimed = new Set(ids.filter((x): x is string => typeof x === 'string'));
        const before = doc.items.length;
        doc.items = doc.items.filter((i) => !claimed.has(i.id));
        if (doc.items.length !== before) writeInbox(userId, doc);
        return { ok: true, remaining: doc.items.length };
    });
}
