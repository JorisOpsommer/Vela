// HTTP hardening: response headers, the client IP behind the tunnel, and same-origin
// checks for state-changing requests.
import type { FastifyReply, FastifyRequest } from 'fastify';
import net from 'node:net';

export const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    // The chart kit injects its component styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
].join('; ');

export function applySecurityHeaders(reply: FastifyReply, secure: boolean): void {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function isPrivate(ip: string): boolean {
    const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (net.isIPv4(v4)) {
        const [a, b] = v4.split('.').map(Number) as [number, number];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

/**
 * The browser's IP. Forwarded headers are honoured only when `trust` is on AND the TCP
 * peer is on a private network (the tunnel container) — a direct internet client cannot
 * spoof its way past the login limiter.
 */
export function clientIp(req: FastifyRequest, trust: boolean): string {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!trust || !isPrivate(peer)) return peer;
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && net.isIP(cf.trim())) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    const first = typeof xff === 'string' ? xff.split(',')[0]?.trim() : undefined;
    if (first && net.isIP(first)) return first;
    return peer;
}

/** `Origin` (or, failing that, `Referer`) must name this site. Absent both ⇒ reject. */
export function sameOrigin(req: FastifyRequest, publicOrigin: string | null): boolean {
    const raw = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined);
    if (!raw) return false;
    let origin: URL;
    try {
        origin = new URL(raw);
    } catch {
        return false;
    }
    if (publicOrigin) return origin.origin === publicOrigin;
    const host = req.headers.host;
    return !!host && origin.host === host;
}
