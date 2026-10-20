// Runtime configuration, read once from the environment. Secrets never leave the
// server: the browser only ever talks to this process.
import path from 'node:path';

export interface AppConfig {
    port: number;
    host: string;
    dataDir: string;
    /** Directory holding the built web assets (index.html, login.html, assets/). */
    webDir: string;
    /** Directory holding tickers.json. */
    configDir: string;
    sessionSecret: string;
    /** Secure cookies (`__Host-` prefix). Off only for plain-HTTP LAN testing. */
    cookieSecure: boolean;
    sessionTtlMs: number;
    admin: { username: string; password: string } | null;
    finnhubKey: string | null;
    alpaca: { keyId: string; secret: string; dataUrl: string; tradingUrl: string } | null;
}

function bool(v: string | undefined, fallback: boolean): boolean {
    if (v == null || v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(v.trim());
}

function str(v: string | undefined): string | null {
    const t = v?.trim();
    return t ? t : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const sessionSecret = str(env.SESSION_SECRET);
    if (!sessionSecret || sessionSecret.length < 32) {
        throw new Error('SESSION_SECRET must be set to at least 32 characters (e.g. `openssl rand -hex 32`).');
    }
    const keyId = str(env.ALPACA_API_KEY_ID);
    const secret = str(env.ALPACA_API_SECRET_KEY);
    const adminUser = str(env.ADMIN_USERNAME);
    const adminPass = str(env.ADMIN_PASSWORD);
    const here = path.dirname(new URL(import.meta.url).pathname);
    return {
        port: Number(env.PORT ?? 8080),
        host: env.HOST ?? '0.0.0.0',
        dataDir: path.resolve(env.DATA_DIR ?? path.join(here, '../../data')),
        webDir: path.resolve(env.WEB_DIR ?? path.join(here, '../web')),
        configDir: path.resolve(env.CONFIG_DIR ?? path.join(here, '../../config')),
        sessionSecret,
        cookieSecure: bool(env.COOKIE_SECURE, true),
        sessionTtlMs: Number(env.SESSION_TTL_DAYS ?? 14) * 86_400_000,
        admin: adminUser && adminPass ? { username: adminUser, password: adminPass } : null,
        finnhubKey: str(env.FINNHUB_API_KEY),
        alpaca: keyId && secret
            ? {
                  keyId,
                  secret,
                  dataUrl: str(env.ALPACA_DATA_URL)?.replace(/\/+$/, '') ?? 'https://data.alpaca.markets',
                  tradingUrl: (str(env.ALPACA_TRADING_URL) ?? 'https://paper-api.alpaca.markets/v2').replace(/\/+$/, ''),
              }
            : null,
    };
}
