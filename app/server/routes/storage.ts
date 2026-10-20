// Per-account key/value store behind the chart's storage adapter (layouts, drawings,
// indicator setups) and the watchlist.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';

const KEY_RE = /^[a-zA-Z0-9._:-]{1,64}$/;
const MAX_VALUE_BYTES = 3 * 1024 * 1024;
const MAX_KEYS_PER_USER = 200;

export function registerStorageRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { db } = ctx;
    // Text bodies arrive as-is (the chart writes serialized JSON documents).
    app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: MAX_VALUE_BYTES }, (_req, body, done) => done(null, body));

    app.get('/api/storage/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Bad key.' });
        const row = db.prepare('SELECT value FROM user_storage WHERE user_id = ? AND key = ?').get(req.session!.user.id, key) as { value: string } | undefined;
        if (!row) return reply.code(404).send({ error: 'Not found.' });
        return reply.type('text/plain; charset=utf-8').send(row.value);
    });

    app.put('/api/storage/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Bad key.' });
        const value = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
        if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return reply.code(413).send({ error: 'Too large.' });
        const userId = req.session!.user.id;
        const count = (db.prepare('SELECT COUNT(*) AS n FROM user_storage WHERE user_id = ?').get(userId) as { n: number }).n;
        const exists = db.prepare('SELECT 1 FROM user_storage WHERE user_id = ? AND key = ?').get(userId, key);
        if (!exists && count >= MAX_KEYS_PER_USER) return reply.code(409).send({ error: 'Storage key limit reached.' });
        db.prepare('INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(userId, key, value, Date.now());
        return { ok: true };
    });

    app.delete('/api/storage/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Bad key.' });
        db.prepare('DELETE FROM user_storage WHERE user_id = ? AND key = ?').run(req.session!.user.id, key);
        return { ok: true };
    });
}
