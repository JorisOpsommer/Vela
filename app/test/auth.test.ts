import { describe, expect, it } from 'vitest';
import { openDbAt } from '../server/db';
import { AuthService } from '../server/auth/service';
import { SecretBox } from '../server/auth/secret-box';
import { hashPassword, verifyPassword } from '../server/auth/passwords';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../server/auth/totp';
import { FailureLimiter } from '../server/auth/rate-limit';

const SECRET = 'x'.repeat(40);
const PW = 'correct horse battery staple';

function service(now?: () => number) {
    return new AuthService(openDbAt(':memory:'), new SecretBox(SECRET), 86_400_000, now);
}

describe('passwords', () => {
    it('hashes with argon2id and verifies', async () => {
        const h = await hashPassword(PW);
        expect(h.startsWith('$argon2id$v=19$')).toBe(true);
        expect(await verifyPassword(PW, h)).toBe(true);
        expect(await verifyPassword('wrong', h)).toBe(false);
        expect(await verifyPassword(PW, 'garbage')).toBe(false);
    });
});

describe('TOTP', () => {
    it('matches the RFC 6238 SHA-1 test vector', () => {
        const secret = base32Encode(Buffer.from('12345678901234567890'));
        expect(totpAt(secret, 59_000)).toBe('287082');
        expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
        expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    });
    it('accepts one step of drift and rejects malformed codes', () => {
        const secret = base32Encode(Buffer.from('12345678901234567890'));
        expect(verifyTotp(secret, totpAt(secret, 1_000_000_000), 1_000_030_000)).toBe(true);
        expect(verifyTotp(secret, totpAt(secret, 1_000_000_000), 1_000_200_000)).toBe(false);
        expect(verifyTotp(secret, 'abcdef')).toBe(false);
    });
});

describe('SecretBox', () => {
    it('round-trips and rejects tampering', () => {
        const box = new SecretBox(SECRET);
        const sealed = box.seal('JBSWY3DPEHPK3PXP');
        expect(box.open(sealed)).toBe('JBSWY3DPEHPK3PXP');
        expect(box.open(sealed.slice(0, -2) + 'AA')).toBeNull();
        expect(new SecretBox('y'.repeat(40)).open(sealed)).toBeNull();
    });
});

describe('AuthService', () => {
    it('creates users, logs in, and rejects bad credentials', async () => {
        const auth = service();
        await auth.createUser('alice', PW, 'admin');
        expect((await auth.login('alice', PW, undefined)).ok).toBe(true);
        expect((await auth.login('ALICE', PW, undefined)).ok).toBe(true);
        expect((await auth.login('alice', 'nope', undefined)).ok).toBe(false);
        expect((await auth.login('bob', PW, undefined)).ok).toBe(false);
        await expect(auth.createUser('alice', PW, 'user')).rejects.toThrow(/taken/);
        await expect(auth.createUser('x', PW, 'user')).rejects.toThrow(/Username/);
        await expect(auth.createUser('carol', 'short', 'user')).rejects.toThrow(/12/);
    });

    it('stores only a hash of the session token and expires sessions', async () => {
        let now = 1_000_000;
        const auth = service(() => now);
        const u = await auth.createUser('alice', PW, 'user');
        const s = auth.createSession(u.id, {});
        expect(auth.getSession(s.token)?.user.username).toBe('alice');
        expect(auth.getSession(s.token + 'x')).toBeNull();
        now += 2 * 86_400_000;
        expect(auth.getSession(s.token)).toBeNull();
    });

    it('slides an active session forward and flags the cookie for re-issue', async () => {
        let now = 1_000_000;
        const auth = service(() => now);
        const u = await auth.createUser('alice', PW, 'user');
        const s = auth.createSession(u.id, {});
        expect(auth.getSession(s.token)?.refreshed).toBe(false);
        now += 20 * 3_600_000;
        const later = auth.getSession(s.token)!;
        expect(later.refreshed).toBe(true);
        expect(later.expiresAt).toBe(now + 86_400_000);
        now += 20 * 3_600_000; // 40 h after sign-in, past the original 24 h expiry
        expect(auth.getSession(s.token)).not.toBeNull();
    });

    it('requires and enforces TOTP once enrolled, and refuses code reuse', async () => {
        let now = Date.UTC(2026, 9, 20, 12, 0, 0);
        const auth = service(() => now);
        const u = await auth.createUser('alice', PW, 'user');
        const secret = auth.beginTotp(u.id);
        auth.confirmTotp(u.id, totpAt(secret, now));
        expect(await auth.login('alice', PW, undefined)).toEqual({ ok: false, totpRequired: true });
        expect((await auth.login('alice', PW, '000000')).ok).toBe(false);
        now += 30_000;
        const code = totpAt(secret, now);
        expect((await auth.login('alice', PW, code)).ok).toBe(true);
        expect((await auth.login('alice', PW, code)).ok).toBe(false);
    });

    it('disabling a user ends their sessions; the last admin is protected', async () => {
        const auth = service();
        const admin = await auth.createUser('root', PW, 'admin');
        const u = await auth.createUser('alice', PW, 'user');
        const s = auth.createSession(u.id, {});
        auth.updateUser(u.id, { disabled: true });
        expect(auth.getSession(s.token)).toBeNull();
        expect((await auth.login('alice', PW, undefined)).ok).toBe(false);
        expect(() => auth.updateUser(admin.id, { role: 'user' })).toThrow(/admin/);
        expect(() => auth.deleteUser(admin.id)).toThrow(/admin/);
    });

    it('a password reset forces a change and signs the user out', async () => {
        const auth = service();
        const u = await auth.createUser('alice', PW, 'user');
        const s = auth.createSession(u.id, {});
        await auth.setPassword(u.id, 'a brand new password', true);
        expect(auth.getSession(s.token)).toBeNull();
        const r = await auth.login('alice', 'a brand new password', undefined);
        expect(r.ok && r.user.mustChangePassword).toBe(true);
    });
});

describe('FailureLimiter', () => {
    it('locks after repeated failures and backs off', () => {
        let now = 0;
        const lim = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, lockMs: 1_000, maxLockMs: 10_000 }, () => now);
        for (let i = 0; i < 3; i++) lim.fail('k');
        expect(lim.retryAfter('k')).toBe(1_000);
        now += 1_001;
        expect(lim.retryAfter('k')).toBe(0);
        for (let i = 0; i < 3; i++) lim.fail('k');
        expect(lim.retryAfter('k')).toBe(2_000);
        lim.succeed('k');
        expect(lim.retryAfter('k')).toBe(0);
    });
});
