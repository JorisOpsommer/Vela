import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import type { AppContext } from '../app';
import { AuthError } from '../auth/service';
import { totpUri } from '../auth/totp';

const ISSUER = 'Vela Charts';

function publicUser(u: { id: number; username: string; role: string; totpEnabled: boolean; mustChangePassword: boolean }) {
    return { id: u.id, username: u.username, role: u.role, totpEnabled: u.totpEnabled, mustChangePassword: u.mustChangePassword };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
    const { auth } = ctx;

    app.post('/api/auth/login', async (req, reply) => {
        const body = (req.body ?? {}) as { username?: unknown; password?: unknown; code?: unknown };
        const ipKey = `ip:${req.clientIp}`;
        const userKey = `u:${String(body.username ?? '').toLowerCase().slice(0, 64)}`;
        const wait = Math.max(ctx.loginLimiterIp.retryAfter(ipKey), ctx.loginLimiterUser.retryAfter(userKey));
        if (wait > 0) {
            reply.header('Retry-After', String(Math.ceil(wait / 1000)));
            return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} minute(s).` });
        }
        const res = await auth.login(body.username, body.password, body.code);
        if (!res.ok) {
            // A missing second factor after a correct password is not a failure.
            const missingCode = res.totpRequired && (body.code == null || body.code === '');
            if (!missingCode) {
                ctx.loginLimiterIp.fail(ipKey);
                ctx.loginLimiterUser.fail(userKey);
                req.log.warn({ ip: req.clientIp, user: String(body.username ?? '').slice(0, 64) }, 'login failed');
            }
            return reply.code(401).send(res.totpRequired ? { error: missingCode ? 'Enter the code from your authenticator app.' : 'That code is not valid.', totpRequired: true } : { error: 'Wrong username or password.' });
        }
        ctx.loginLimiterIp.succeed(ipKey);
        ctx.loginLimiterUser.succeed(userKey);
        const s = auth.createSession(res.user.id, { ip: req.clientIp, userAgent: req.headers['user-agent'] });
        ctx.setSessionCookie(reply, s.token, s.expiresAt);
        req.log.info({ ip: req.clientIp, user: res.user.username }, 'login');
        return { user: publicUser(res.user), csrf: s.csrf };
    });

    app.post('/api/auth/logout', async (req, reply) => {
        auth.destroySession(req.sessionToken);
        ctx.clearSessionCookie(reply);
        return { ok: true };
    });

    app.get('/api/auth/me', async (req) => {
        const s = req.session!;
        return { user: publicUser(s.user), csrf: s.csrf };
    });

    app.post('/api/auth/password', async (req, reply) => {
        const body = (req.body ?? {}) as { current?: unknown; next?: unknown };
        try {
            await auth.changePassword(req.session!.user.id, body.current, body.next, req.sessionToken);
            return { ok: true };
        } catch (err) {
            if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
            throw err;
        }
    });

    app.post('/api/auth/totp/setup', async (req) => {
        const user = req.session!.user;
        const secret = auth.beginTotp(user.id);
        const uri = totpUri(secret, user.username, ISSUER);
        const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 });
        return { secret, uri, qrSvg: qr };
    });

    app.post('/api/auth/totp/confirm', async (req, reply) => {
        try {
            auth.confirmTotp(req.session!.user.id, (req.body as { code?: unknown } | null)?.code);
            return { ok: true };
        } catch (err) {
            if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
            throw err;
        }
    });

    app.post('/api/auth/totp/disable', async (req, reply) => {
        try {
            await auth.disableTotp(req.session!.user.id, (req.body as { password?: unknown } | null)?.password);
            return { ok: true };
        } catch (err) {
            if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
            throw err;
        }
    });
}
