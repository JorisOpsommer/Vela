import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { clientIp, isHttps, sameOrigin } from '../server/security';

const req = (peer: string, headers: Record<string, string>, encrypted = false) => ({ socket: { remoteAddress: peer, encrypted }, headers }) as unknown as FastifyRequest;

describe('clientIp', () => {
    it('reads the forwarded IP when the proxy connects from a private network', () => {
        expect(clientIp(req('192.168.1.10', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
        expect(clientIp(req('::ffff:172.18.0.2', { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }))).toBe('198.51.100.4');
    });
    it('ignores forwarded headers from a public peer, which could forge them', () => {
        expect(clientIp(req('198.51.100.99', { 'x-forwarded-for': '1.2.3.4' }))).toBe('198.51.100.99');
    });
});

describe('sameOrigin', () => {
    it('matches the Origin against the Host the request was addressed to', () => {
        expect(sameOrigin(req('10.0.0.1', { host: 'charts.example.com', origin: 'https://charts.example.com' }))).toBe(true);
        expect(sameOrigin(req('10.0.0.1', { host: 'charts.example.com', origin: 'https://evil.example' }))).toBe(false);
        expect(sameOrigin(req('10.0.0.1', { host: 'charts.example.com' }))).toBe(false);
    });
});

describe('isHttps', () => {
    it('trusts X-Forwarded-Proto only from a proxy on a private network', () => {
        expect(isHttps(req('192.168.1.10', { 'x-forwarded-proto': 'https' }))).toBe(true);
        expect(isHttps(req('::ffff:172.18.0.2', { 'x-forwarded-proto': 'https, http' }))).toBe(true);
        expect(isHttps(req('198.51.100.99', { 'x-forwarded-proto': 'https' }))).toBe(false);
    });
    it('treats direct LAN access as plain HTTP and a TLS socket as HTTPS', () => {
        expect(isHttps(req('192.168.1.20', {}))).toBe(false);
        expect(isHttps(req('192.168.1.20', { 'x-forwarded-proto': 'http' }))).toBe(false);
        expect(isHttps(req('198.51.100.99', {}, true))).toBe(true);
    });
});
