// Accounts and sessions. Session ids are 256-bit random values; only their SHA-256 lands
// in the database, so a leaked file cannot be replayed as a cookie.
import crypto from 'node:crypto';
import type { Db } from '../db';
import { dummyPasswordHash, hashPassword, validateNewPassword, verifyPassword } from './passwords';
import { generateTotpSecret, totpAt, verifyTotp } from './totp';
import type { SecretBox } from './secret-box';

export type Role = 'admin' | 'user';

export interface User {
    id: number;
    username: string;
    role: Role;
    totpEnabled: boolean;
    disabled: boolean;
    mustChangePassword: boolean;
    createdAt: number;
}

export interface Session {
    user: User;
    csrf: string;
    expiresAt: number;
    /** The expiry just slid forward — the cookie should be re-issued to match. */
    refreshed: boolean;
}

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    role: Role;
    totp_secret: string | null;
    totp_enabled: number;
    disabled: number;
    must_change_password: number;
    created_at: number;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
/** Sliding-session refresh: extend expiry at most once per this interval. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

function toUser(r: UserRow): User {
    return {
        id: r.id,
        username: r.username,
        role: r.role,
        totpEnabled: r.totp_enabled === 1,
        disabled: r.disabled === 1,
        mustChangePassword: r.must_change_password === 1,
        createdAt: r.created_at,
    };
}

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

export class AuthError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

export type LoginResult = { ok: true; user: User } | { ok: false; totpRequired?: boolean };

export class AuthService {
    /** Last accepted TOTP step per user — a code is good for one login only. */
    private readonly usedTotpStep = new Map<number, number>();
    private readonly pendingTotp = new Map<number, { secret: string; expires: number }>();

    constructor(
        private readonly db: Db,
        private readonly box: SecretBox,
        private readonly sessionTtlMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    userCount(): number {
        return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    }

    listUsers(): User[] {
        return (this.db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[]).map(toUser);
    }

    getUser(id: number): User | null {
        const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
        return r ? toUser(r) : null;
    }

    async createUser(username: string, password: string, role: Role, opts: { mustChangePassword?: boolean } = {}): Promise<User> {
        if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
            throw new AuthError('Username must be 3–32 characters: letters, digits, dot, dash or underscore.');
        }
        const pwErr = validateNewPassword(password);
        if (pwErr) throw new AuthError(pwErr);
        if (role !== 'admin' && role !== 'user') throw new AuthError('Invalid role.');
        const exists = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
        if (exists) throw new AuthError('That username is taken.', 409);
        const t = this.now();
        const hash = await hashPassword(password);
        const res = this.db
            .prepare('INSERT INTO users (username, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(username, hash, role, opts.mustChangePassword ? 1 : 0, t, t);
        return this.getUser(Number(res.lastInsertRowid))!;
    }

    /** Verify credentials (and the second factor when enrolled). Constant work whether or
     *  not the account exists. */
    async login(username: unknown, password: unknown, totpCode: unknown): Promise<LoginResult> {
        if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256 || username.length > 64) {
            await verifyPassword('x', await dummyPasswordHash());
            return { ok: false };
        }
        const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
        const valid = await verifyPassword(password, row?.password_hash ?? (await dummyPasswordHash()));
        if (!row || !valid || row.disabled === 1) return { ok: false };
        if (row.totp_enabled === 1) {
            const secret = row.totp_secret ? this.box.open(row.totp_secret) : null;
            if (!secret) return { ok: false };
            if (totpCode == null || totpCode === '') return { ok: false, totpRequired: true };
            if (!this.acceptTotp(row.id, secret, totpCode)) return { ok: false, totpRequired: true };
        }
        return { ok: true, user: toUser(row) };
    }

    private acceptTotp(userId: number, secret: string, code: unknown): boolean {
        const t = this.now();
        if (!verifyTotp(secret, code, t)) return false;
        const step = this.matchingStep(secret, String(code).trim(), t);
        const last = this.usedTotpStep.get(userId) ?? -1;
        if (step <= last) return false;
        this.usedTotpStep.set(userId, step);
        return true;
    }

    private matchingStep(secret: string, code: string, t: number): number {
        for (const drift of [1, 0, -1]) {
            const at = t + drift * 30_000;
            if (totpAt(secret, at) === code) return Math.floor(at / 30_000);
        }
        return -1;
    }

    createSession(userId: number, meta: { ip?: string; userAgent?: string }): { token: string; csrf: string; expiresAt: number } {
        const token = crypto.randomBytes(32).toString('base64url');
        const csrf = crypto.randomBytes(24).toString('base64url');
        const t = this.now();
        const expiresAt = t + this.sessionTtlMs;
        this.db
            .prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(sha256(token), userId, csrf, t, expiresAt, t, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 256));
        this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
        return { token, csrf, expiresAt };
    }

    /** Resolve a cookie token; slides the expiry forward on activity. */
    getSession(token: string | undefined): Session | null {
        if (!token || token.length > 100) return null;
        const id = sha256(token);
        const row = this.db
            .prepare('SELECT s.csrf, s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?')
            .get(id) as (UserRow & { csrf: string; expires_at: number; last_seen: number }) | undefined;
        const t = this.now();
        if (!row || row.expires_at < t || row.disabled === 1) {
            if (row) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(id);
            return null;
        }
        let expiresAt = row.expires_at;
        const refreshed = t - row.last_seen > TOUCH_INTERVAL_MS;
        if (refreshed) {
            expiresAt = t + this.sessionTtlMs;
            this.db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?').run(t, expiresAt, id);
        }
        return { user: toUser(row), csrf: row.csrf, expiresAt, refreshed };
    }

    destroySession(token: string | undefined): void {
        if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
    }

    destroyUserSessions(userId: number, exceptToken?: string): void {
        if (exceptToken) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, sha256(exceptToken));
        else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }

    async changePassword(userId: number, current: unknown, next: unknown, keepToken?: string): Promise<void> {
        const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
        if (!row) throw new AuthError('Unknown user.', 404);
        if (typeof current !== 'string' || !(await verifyPassword(current, row.password_hash))) {
            throw new AuthError('Current password is incorrect.', 403);
        }
        await this.setPassword(userId, next, false);
        this.destroyUserSessions(userId, keepToken);
    }

    /** Admin reset: the user must pick a new password at next login. */
    async setPassword(userId: number, next: unknown, mustChange: boolean): Promise<void> {
        const err = validateNewPassword(next);
        if (err) throw new AuthError(err);
        const hash = await hashPassword(next as string);
        this.db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?').run(hash, mustChange ? 1 : 0, this.now(), userId);
        if (mustChange) this.destroyUserSessions(userId);
    }

    updateUser(userId: number, patch: { role?: Role; disabled?: boolean }): User {
        const u = this.getUser(userId);
        if (!u) throw new AuthError('Unknown user.', 404);
        const role = patch.role ?? u.role;
        if (role !== 'admin' && role !== 'user') throw new AuthError('Invalid role.');
        const disabled = patch.disabled ?? u.disabled;
        if (u.role === 'admin' && (role !== 'admin' || disabled) && this.activeAdminCount() <= 1) {
            throw new AuthError('At least one active admin must remain.', 409);
        }
        this.db.prepare('UPDATE users SET role = ?, disabled = ?, updated_at = ? WHERE id = ?').run(role, disabled ? 1 : 0, this.now(), userId);
        if (disabled) this.destroyUserSessions(userId);
        return this.getUser(userId)!;
    }

    deleteUser(userId: number): void {
        const u = this.getUser(userId);
        if (!u) throw new AuthError('Unknown user.', 404);
        if (u.role === 'admin' && !u.disabled && this.activeAdminCount() <= 1) throw new AuthError('At least one active admin must remain.', 409);
        this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }

    private activeAdminCount(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
    }

    /** Step 1 of enrolment: a fresh secret, held until the user proves their app has it. */
    beginTotp(userId: number): string {
        const secret = generateTotpSecret();
        this.pendingTotp.set(userId, { secret, expires: this.now() + 10 * 60_000 });
        return secret;
    }

    confirmTotp(userId: number, code: unknown): void {
        const p = this.pendingTotp.get(userId);
        if (!p || p.expires < this.now()) throw new AuthError('Setup expired — start again.', 410);
        if (!this.acceptTotp(userId, p.secret, code)) throw new AuthError('That code is not valid.', 403);
        this.pendingTotp.delete(userId);
        this.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, updated_at = ? WHERE id = ?').run(this.box.seal(p.secret), this.now(), userId);
    }

    async disableTotp(userId: number, password: unknown): Promise<void> {
        const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
        if (!row) throw new AuthError('Unknown user.', 404);
        if (typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) throw new AuthError('Password is incorrect.', 403);
        this.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?').run(this.now(), userId);
    }

    /** Admin escape hatch for a lost phone. */
    resetTotp(userId: number): void {
        this.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?').run(this.now(), userId);
    }
}
