// Password hashing with Node's built-in Argon2id (RFC 9106, OWASP parameters).
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(crypto.argon2);

const PARAMS = { memory: 65_536, passes: 3, parallelism: 4, tagLength: 32 } as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

async function derive(password: string, nonce: Buffer, p: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
    return argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce, ...p });
}

/** PHC-style string: `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>` (base64, no padding). */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const hash = await derive(password, salt, PARAMS);
    return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
    if (!m) return false;
    const expected = Buffer.from(m[5]!, 'base64url');
    const actual = await derive(password, Buffer.from(m[4]!, 'base64url'), {
        memory: Number(m[1]),
        passes: Number(m[2]),
        parallelism: Number(m[3]),
        tagLength: expected.length,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A real hash of a random secret, verified against when the username is unknown so
 *  response timing does not reveal which accounts exist. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
    dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
    return dummyHash;
}

export function validateNewPassword(password: unknown): string | null {
    if (typeof password !== 'string') return 'Password is required.';
    if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    return null;
}
