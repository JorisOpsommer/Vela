// Encrypts small secrets at rest (TOTP seeds) with a key derived from SESSION_SECRET, so a
// leaked database file alone does not hand out second factors.
import crypto from 'node:crypto';

export class SecretBox {
    private readonly key: Buffer;

    constructor(masterSecret: string) {
        this.key = Buffer.from(crypto.hkdfSync('sha256', masterSecret, 'vela-selfhost', 'secret-box-v1', 32));
    }

    seal(plain: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    }

    open(sealed: string): string | null {
        const [v, iv, tag, body] = sealed.split('.');
        if (v !== 'v1' || !iv || !tag || body == null) return null;
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
            decipher.setAuthTag(Buffer.from(tag, 'base64url'));
            return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
        } catch {
            return null;
        }
    }
}
