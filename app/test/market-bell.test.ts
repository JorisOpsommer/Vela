// The market bell's timing: it rings once per open/close it crosses, holds a ring while the
// tab is hidden, drops stale ones (a long sleep), and lets only one window claim a bell.
import { describe, it, expect } from 'vitest';
import { CLOSE_LINES, MarketBell, OPEN_LINES, lastEdgeBetween, type MarketEdge } from '../web/lib/market-bell';

// Tue Aug 11 2026, 09:30–16:00 ET (13:30–20:00 UTC); Wednesday the same.
const D = (day: number, h: number, m = 0): number => Date.UTC(2026, 7, day, h, m);
const WINDOWS = [
    [D(11, 13, 30), D(11, 20)],
    [D(12, 13, 30), D(12, 20)],
] as const;

function harness(start: number, opts: { visible?: boolean; claim?: boolean; windows?: typeof WINDOWS | null } = {}) {
    let now = start;
    let visible = opts.visible ?? true;
    const rings: MarketEdge[] = [];
    const bell = new MarketBell({
        now: () => now,
        windows: () => Promise.resolve(opts.windows === undefined ? WINDOWS : opts.windows),
        visible: () => visible,
        claim: () => opts.claim ?? true,
        ring: (e) => rings.push(e),
    });
    return {
        bell,
        rings,
        at: async (t: number) => {
            now = t;
            await bell.tick();
        },
        show: (v: boolean) => (visible = v),
    };
}

describe('lastEdgeBetween', () => {
    it('finds the open or close crossed, newest first', () => {
        expect(lastEdgeBetween(D(11, 13, 29), D(11, 13, 31), WINDOWS)).toEqual({ kind: 'open', at: D(11, 13, 30) });
        expect(lastEdgeBetween(D(11, 19, 59), D(11, 20), WINDOWS)).toEqual({ kind: 'close', at: D(11, 20) });
        expect(lastEdgeBetween(D(11, 12), D(11, 21), WINDOWS)).toEqual({ kind: 'close', at: D(11, 20) });
        expect(lastEdgeBetween(D(11, 14), D(11, 15), WINDOWS)).toBeNull();
    });
});

describe('MarketBell', () => {
    it('rings once at the open and once at the close', async () => {
        const h = harness(D(11, 13, 29));
        await h.at(D(11, 13, 29) + 15_000);
        await h.at(D(11, 13, 30) + 5_000);
        await h.at(D(11, 13, 30) + 20_000);
        await h.at(D(11, 20) + 10_000);
        expect(h.rings).toEqual([
            { kind: 'open', at: D(11, 13, 30) },
            { kind: 'close', at: D(11, 20) },
        ]);
    });

    it('never rings for the state the page loaded into', async () => {
        const h = harness(D(11, 15));
        await h.at(D(11, 15) + 15_000);
        expect(h.rings).toEqual([]);
    });

    it('holds the bell while the tab is hidden and rings when it comes back', async () => {
        const h = harness(D(11, 19, 59), { visible: false });
        await h.at(D(11, 20) + 15_000);
        expect(h.rings).toEqual([]);
        h.show(true);
        await h.at(D(11, 20, 10));
        expect(h.rings).toEqual([{ kind: 'close', at: D(11, 20) }]);
    });

    it('drops a bell that went stale while hidden or asleep', async () => {
        const h = harness(D(11, 19, 59), { visible: false });
        await h.at(D(11, 20) + 15_000);
        h.show(true);
        await h.at(D(11, 21)); // an hour later
        expect(h.rings).toEqual([]);
    });

    it('a laptop sleeping across the open and close rings only the close, if recent', async () => {
        const h = harness(D(11, 13));
        await h.at(D(11, 20, 5));
        expect(h.rings).toEqual([{ kind: 'close', at: D(11, 20) }]);
    });

    it('another window that already claimed the bell keeps this one quiet', async () => {
        const h = harness(D(11, 13, 29), { claim: false });
        await h.at(D(11, 13, 31));
        expect(h.rings).toEqual([]);
    });

    it('stays quiet without a calendar', async () => {
        const h = harness(D(11, 13, 29), { windows: null });
        await h.at(D(11, 13, 31));
        expect(h.rings).toEqual([]);
    });
});

describe('bell lines', () => {
    it('every line has an icon, a title, and a body', () => {
        for (const l of [...OPEN_LINES, ...CLOSE_LINES]) {
            expect(l.icon.length).toBeGreaterThan(0);
            expect(l.title.length).toBeGreaterThan(0);
            expect(l.body.length).toBeGreaterThan(0);
        }
    });
});
