// Long intraday lookbacks: Alpaca pages hold about ten thousand minutes whatever the bar
// size, so history must reach the present without a hole before the real-time tail, and
// a repeat load must not walk the whole history again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaBridge } from '../server/market/bridges/alpaca';
import type { CatalogEntry } from '../server/market/types';
import { parseTimeframe } from '../server/market/timeframes';

const NOW = Date.UTC(2026, 9, 21, 17, 40); // Wed Oct 21 2026, 13:40 ET
const SIP_DELAY_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

const AAPL = { symbol: 'AAPL', class: 'stock' } as CatalogEntry;

function fakeAlpaca() {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith('/calendar')) {
            const y = Number(url.searchParams.get('start')!.slice(0, 4));
            const rows = [];
            for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += DAY_MS) {
                const wd = new Date(t).getUTCDay();
                if (wd !== 0 && wd !== 6) rows.push({ date: new Date(t).toISOString().slice(0, 10), open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' });
            }
            return json(rows);
        }
        const p = url.searchParams;
        const step = Number(/^(\d+)/.exec(p.get('timeframe')!)![1]) * (p.get('timeframe')!.endsWith('Hour') ? 60 : 1) * 60_000;
        const start = Date.parse(p.get('start')!);
        const end = p.get('end') ? Date.parse(p.get('end')!) : p.get('feed') === 'sip' ? NOW - SIP_DELAY_MS : NOW;
        const desc = p.get('sort') === 'desc';
        // A page holds about ten thousand minutes of tape, as the live service does.
        const pageBars = Math.max(1, Math.floor((10_000 * 60_000) / step));
        const all: number[] = [];
        for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
            // Weekdays, 04:00–20:00 New York (summer time, near enough for the whole range).
            const wd = new Date(t).getUTCDay();
            if (wd !== 0 && wd !== 6 && new Date(t).getUTCHours() >= 8) all.push(t);
        }
        if (desc) all.reverse();
        const token = p.get('page_token');
        const from = token ? all.indexOf(Number(token)) : 0;
        const page = all.slice(from, from + pageBars);
        const next = all[from + pageBars];
        return json({
            bars: { AAPL: page.map((t) => ({ t: new Date(t).toISOString(), o: 1, h: 1, l: 1, c: 1, v: 1 })) },
            next_page_token: next != null ? String(next) : null,
        });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('AlpacaBridge — long intraday history', () => {
    it('reaches the present with no hole before the real-time tail', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        fakeAlpaca();
        const alpaca = new AlpacaBridge({ keyId: 'k', secret: 's', dataUrl: 'https://data.test', tradingUrl: 'https://trading.test/v2' });
        const bars = await alpaca.getBars('AAPL', parseTimeframe('60')!, { limit: 1000, session: 'regular' }, AAPL);
        expect(bars.length).toBe(1000);
        const longest = Math.max(...bars.slice(1).map((b, i) => b.time - bars[i]!.time));
        expect(longest).toBeLessThan(4 * DAY_MS); // weekends only
        // Yesterday's last hour and this morning's are both there.
        expect(bars.some((b) => b.time === Date.UTC(2026, 9, 20, 19, 30))).toBe(true);
        expect(bars.some((b) => b.time === Date.UTC(2026, 9, 21, 15, 30))).toBe(true);
    });

    it('a repeat load fetches only the newest stretch again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const { calls } = fakeAlpaca();
        const alpaca = new AlpacaBridge({ keyId: 'k', secret: 's', dataUrl: 'https://data.test', tradingUrl: 'https://trading.test/v2' });
        const tf = parseTimeframe('240')!;
        await alpaca.getBars('AAPL', tf, { limit: 500, session: 'regular' }, AAPL);
        const first = calls.filter((c) => c.endsWith('/bars')).length;
        vi.setSystemTime(NOW + 2 * 60_000);
        await alpaca.getBars('AAPL', tf, { limit: 500, session: 'regular' }, AAPL);
        const again = calls.filter((c) => c.endsWith('/bars')).length - first;
        expect(again).toBeLessThanOrEqual(3);
    });

    it('a finished daily bar keeps its consolidated close instead of the IEX tail close', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.UTC(2026, 9, 22, 12)); // Thu Oct 22 2026, 08:00 ET
        const days = [Date.UTC(2026, 9, 19, 4), Date.UTC(2026, 9, 20, 4), Date.UTC(2026, 9, 21, 4)];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL) => {
                const p = new URL(String(input)).searchParams;
                const from = Date.parse(p.get('start')!);
                const iex = p.get('feed') === 'iex';
                // IEX also has today's pre-market bar; SIP does not yet.
                const list = iex ? [...days, Date.UTC(2026, 9, 22, 4)] : days;
                const bars = list.filter((t) => t >= from).map((t) => ({ t: new Date(t).toISOString(), o: 1, h: 1, l: 1, c: iex ? 343.935 : 343.99, v: 1 }));
                return json({ bars: { AAPL: bars }, next_page_token: null });
            }),
        );
        const alpaca = new AlpacaBridge({ keyId: 'k', secret: 's', dataUrl: 'https://data.test', tradingUrl: 'https://trading.test/v2' });
        const bars = await alpaca.getBars('AAPL', parseTimeframe('1D')!, { limit: 10, session: 'regular' }, AAPL);
        expect(bars.find((b) => b.time === days[2])!.close).toBe(343.99);
        expect(bars.find((b) => b.time === Date.UTC(2026, 9, 22, 4))!.close).toBe(343.935);
    });
});
