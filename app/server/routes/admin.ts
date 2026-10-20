import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../app';
import { AuthError, type Role } from '../auth/service';

function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    throw err;
}

function idParam(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { auth } = ctx;

    app.get('/api/admin/users', async () => ({ users: auth.listUsers() }));

    app.post('/api/admin/users', async (req, reply) => {
        const b = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown };
        try {
            // The new user picks their own password at first sign-in.
            const user = await auth.createUser(String(b.username ?? ''), String(b.password ?? ''), (b.role === 'admin' ? 'admin' : 'user') as Role, { mustChangePassword: true });
            req.log.info({ by: req.session!.user.username, user: user.username }, 'user created');
            return { user };
        } catch (err) {
            return fail(reply, err);
        }
    });

    app.patch('/api/admin/users/:id', async (req, reply) => {
        const id = idParam((req.params as { id: string }).id);
        if (!id) return reply.code(400).send({ error: 'Bad id.' });
        const b = (req.body ?? {}) as { role?: unknown; disabled?: unknown };
        if (id === req.session!.user.id && (b.disabled === true || b.role === 'user')) return reply.code(409).send({ error: 'You cannot demote or disable yourself.' });
        try {
            return { user: auth.updateUser(id, { ...(b.role === 'admin' || b.role === 'user' ? { role: b.role } : {}), ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}) }) };
        } catch (err) {
            return fail(reply, err);
        }
    });

    app.post('/api/admin/users/:id/password', async (req, reply) => {
        const id = idParam((req.params as { id: string }).id);
        if (!id) return reply.code(400).send({ error: 'Bad id.' });
        try {
            await auth.setPassword(id, (req.body as { password?: unknown } | null)?.password, id !== req.session!.user.id);
            return { ok: true };
        } catch (err) {
            return fail(reply, err);
        }
    });

    app.post('/api/admin/users/:id/reset-totp', async (req, reply) => {
        const id = idParam((req.params as { id: string }).id);
        if (!id) return reply.code(400).send({ error: 'Bad id.' });
        auth.resetTotp(id);
        return { ok: true };
    });

    app.delete('/api/admin/users/:id', async (req, reply) => {
        const id = idParam((req.params as { id: string }).id);
        if (!id) return reply.code(400).send({ error: 'Bad id.' });
        if (id === req.session!.user.id) return reply.code(409).send({ error: 'You cannot delete yourself.' });
        try {
            auth.deleteUser(id);
            return { ok: true };
        } catch (err) {
            return fail(reply, err);
        }
    });
}
