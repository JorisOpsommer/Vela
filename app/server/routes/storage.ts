// Per-account key/value store behind the chart's storage adapter (layouts, drawings,
// indicator setups) and the watchlist. Every value carries a revision (its last write time):
// a write that names a stale revision is refused, so a tab that has not seen another
// device's save cannot silently overwrite it.
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
        const row = db.prepare('SELECT value, updated_at FROM user_storage WHERE user_id = ? AND key = ?').get(req.session!.user.id, key) as { value: string; updated_at: number } | undefined;
        if (!row) return reply.code(404).send({ error: 'Not found.' });
        return reply.header('x-storage-revision', String(row.updated_at)).type('text/plain; charset=utf-8').send(row.value);
    });

    app.put('/api/storage/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Bad key.' });
        const value = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
        if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return reply.code(413).send({ error: 'Too large.' });
        const userId = req.session!.user.id;
        const current = db.prepare('SELECT updated_at FROM user_storage WHERE user_id = ? AND key = ?').get(userId, key) as { updated_at: number } | undefined;
        // The writer names the revision it built on; a newer save from another device refuses it.
        const base = req.headers['x-base-revision'];
        if (current && base !== undefined && String(current.updated_at) !== String(base)) {
            return reply.code(409).send({ error: 'Changed on another device.', revision: current.updated_at });
        }
        const count = (db.prepare('SELECT COUNT(*) AS n FROM user_storage WHERE user_id = ?').get(userId) as { n: number }).n;
        if (!current && count >= MAX_KEYS_PER_USER) return reply.code(409).send({ error: 'Storage key limit reached.' });
        const revision = Math.max(Date.now(), (current?.updated_at ?? 0) + 1);
        db.prepare('INSERT INTO user_storage (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(userId, key, value, revision);
        return { ok: true, revision };
    });

    app.delete('/api/storage/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'Bad key.' });
        db.prepare('DELETE FROM user_storage WHERE user_id = ? AND key = ?').run(req.session!.user.id, key);
        return { ok: true };
    });
}
