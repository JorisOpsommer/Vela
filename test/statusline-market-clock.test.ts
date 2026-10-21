// @vitest-environment jsdom
// The status line's market clock: the countdown beside the market badge, ticking on the
// host's wall clock, flipping the badge as a session edge passes, hiding with the market
// part and during a replay, and opening the hours card (desktop) or sheet (phone).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Statusline } from '../src/widget/statusline';
import type { MarketSchedule } from '../src/widget/market-status';
import type { WallClock } from '../src/core/util/wall-clock';

// jsdom ships no CSS.escape; the kit's style injection needs it for its id lookup.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

// Wed 21 Oct 2026 (EDT): regular 09:30–16:00, extended 04:00–20:00 ET.
const ny = (day: number, h: number, m = 0): number => Date.UTC(2026, 9, day, h + 4, m);
const SCHEDULE: MarketSchedule = {
    windows: {
        regular: [20, 21, 22].map((d) => [ny(d, 9, 30), ny(d, 16)] as const),
        extended: [20, 21, 22].map((d) => [ny(d, 4), ny(d, 20)] as const),
    },
    tz: 'America/New_York',
    overnight: false,
    horizon: ny(22, 23),
};

function fakeClock(): WallClock & { tick(now: number): void } {
    const subs = new Set<(now: number) => void>();
    return {
        onTick: (cb) => {
            subs.add(cb);
            return () => subs.delete(cb);
        },
        tick: (now) => subs.forEach((cb) => cb(now)),
    };
}

function make(layout: 'desktop' | 'mobile' = 'desktop') {
    const root = document.createElement('div');
    root.dataset.layout = layout;
    root.className = 'vela-ui';
    const host = document.createElement('div');
    root.appendChild(host);
    document.body.appendChild(root);
    const line = new Statusline(host, 'SPY');
    const clock = fakeClock();
    const sheetOpen: boolean[] = [];
    line.attachMarketClock({ clock, timezone: () => 'Europe/Brussels', sheetHost: root, onSheetOpenChange: (o) => sheetOpen.push(o) });
    const market = line.el.querySelector<HTMLElement>('.vela-sl-market')!;
    const long = market.querySelector<HTMLElement>('.vela-sl-cd-long')!;
    const short = market.querySelector<HTMLElement>('.vela-sl-cd-short')!;
    return { root, line, clock, market, long, short, sheetOpen };
}

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('Statusline market clock', () => {
    it('shows nothing without a schedule — a continuous market keeps the plain badge', () => {
        const { line, market } = make();
        expect(market.classList.contains('vela-sl-has-clock')).toBe(false);
        expect(market.getAttribute('role')).toBeNull();
        line.setMarketSchedule(null);
        expect(market.classList.contains('vela-sl-has-clock')).toBe(false);
        line.destroy();
    });

    it('counts down to the next edge and flips the badge as it passes', () => {
        vi.useFakeTimers();
        vi.setSystemTime(ny(21, 7, 42)); // 13:42 in Brussels
        const { line, clock, market, long, short } = make();
        line.setMarketSchedule(SCHEDULE);
        expect(market.classList.contains('vela-sl-has-clock')).toBe(true);
        expect(market.dataset.status).toBe('pre');
        expect(long.textContent).toBe('Opens in 1h 48m');
        expect(short.textContent).toBe('1h 48m');
        expect(market.getAttribute('role')).toBe('button');
        expect(market.getAttribute('aria-label')).toBe('Pre-Market. Opens in 1h 48m. Show market hours');

        clock.tick(ny(21, 7, 43));
        expect(long.textContent).toBe('Opens in 1h 47m');
        clock.tick(ny(21, 9, 30)); // the bell
        expect(market.dataset.status).toBe('open');
        expect(long.textContent).toBe('Closes in 6h 30m');
        line.destroy();
    });

    it('hides with the market part and during a replay, and comes back after', () => {
        vi.useFakeTimers();
        vi.setSystemTime(ny(21, 7, 42));
        const { line, market } = make();
        line.setMarketSchedule(SCHEDULE);

        line.setPartVisible('market', false);
        expect(market.style.display).toBe('none');
        line.setPartVisible('market', true);
        expect(market.style.display).toBe('');

        line.setReplaying(true);
        expect(market.classList.contains('vela-sl-has-clock')).toBe(false);
        expect(market.dataset.status).toBe('replay');
        line.setReplaying(false);
        expect(market.classList.contains('vela-sl-has-clock')).toBe(true);
        line.destroy();
    });

    it('a click opens the hours card on a desktop', () => {
        vi.useFakeTimers();
        vi.setSystemTime(ny(21, 7, 42));
        const { line, market } = make('desktop');
        line.setMarketSchedule(SCHEDULE);
        market.click();
        const card = document.querySelector<HTMLElement>('.vela-sl-hours');
        expect(card?.isConnected).toBe(true);
        expect(card?.querySelector('.vela-mh')?.getAttribute('data-variant')).toBe('card');
        expect(card?.querySelector('.vela-mh-headline')?.textContent).toBe('1h 48m');
        expect([...card!.querySelectorAll('.vela-mh-row-time')].map((t) => t.textContent)).toEqual(['10:00 – 15:30', '15:30 – 22:00', '22:00 – 02:00+1']);
        line.destroy();
    });

    it('a resting mouse opens the card; a sweep across the badge does not', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(ny(21, 7, 42));
        const { line, market } = make('desktop');
        line.setMarketSchedule(SCHEDULE);
        const pointer = (type: string): Event => Object.assign(new MouseEvent(type), { pointerType: 'mouse' });
        const open = (): boolean => document.querySelector('.vela-sl-hours')?.isConnected === true;

        market.dispatchEvent(pointer('pointerenter'));
        await vi.advanceTimersByTimeAsync(100);
        market.dispatchEvent(pointer('pointerleave')); // a sweep
        await vi.advanceTimersByTimeAsync(500);
        expect(open()).toBe(false);

        market.dispatchEvent(pointer('pointerenter'));
        await vi.advanceTimersByTimeAsync(350); // a rest
        expect(open()).toBe(true);
        line.destroy();
    });

    it('a tap opens the hours sheet on a phone', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(ny(21, 7, 42));
        const { root, line, market, sheetOpen } = make('mobile');
        line.setMarketSchedule(SCHEDULE);
        market.click();
        expect(document.querySelector('.vela-sl-hours')).toBeNull(); // no desktop card
        const sheet = root.querySelector<HTMLElement>('.vela-mh[data-variant="sheet"]');
        expect(sheet).not.toBeNull();
        expect(sheet!.querySelector('.vela-mh-dial')).not.toBeNull();
        await vi.advanceTimersByTimeAsync(0); // the dialog machine reports the open a tick later
        expect(sheetOpen).toEqual([true]);
        line.destroy(); // torn down while open: the host's keyboard scope must be released
        expect(sheetOpen).toEqual([true, false]);
    });
});
