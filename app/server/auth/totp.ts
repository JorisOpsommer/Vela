// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what every authenticator app speaks.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(s: string): Buffer {
    const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error('invalid base32');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function generateTotpSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret: string, timeMs: number): string {
    const counter = Math.floor(timeMs / 1000 / STEP_S);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
    const offset = mac[mac.length - 1]! & 0x0f;
    const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return code.toString().padStart(DIGITS, '0');
}

/** Accepts the current step and one step either side (clock drift). */
export function verifyTotp(secret: string, code: unknown, nowMs = Date.now()): boolean {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
    const want = Buffer.from(code.trim());
    let ok = false;
    for (const drift of [-1, 0, 1]) {
        const got = Buffer.from(totpAt(secret, nowMs + drift * STEP_S * 1000));
        if (crypto.timingSafeEqual(got, want)) ok = true;
    }
    return ok;
}

export function totpUri(secret: string, account: string, issuer: string): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}
