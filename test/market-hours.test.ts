// The market clock behind the status line's countdown tag and hours card
// (src/widget/market-status.ts derivations + src/widget/market-hours.ts view model):
// the next event and its wording, the trading day in focus, the upcoming holidays /
// early closes / open-time shifts, all against a real US calendar seen from Brussels —
// Europe changes clocks on 25 Oct 2026, the US on 1 Nov, so the open moves 15:30 →
// 14:30 → 15:30 local across those weeks. DOM-free — node env.
import { describe, it, expect } from 'vitest';
import { marketDayAt, nextMarketEvent, upcomingMarketNotices, type MarketSchedule, type MarketWindows } from '../src/widget/market-status';
import { formatWait, marketClock, marketHoursCard } from '../src/widget/market-hours';

const NY = 'America/New_York';
const BXL = 'Europe/Brussels';

/** New York wall time → epoch ms (EDT until Sun 1 Nov 2026, EST after). */
const ny = (month: number, day: number, h: number, m = 0): number => {
    const offset = month < 11 || (month === 11 && day < 1) ? 4 : 5;
    return Date.UTC(2026, month - 1, day, h + offset, m);
};
const utc = (month: number, day: number, h: number, m = 0): number => Date.UTC(2026, month - 1, day, h, m);

/** Every weekday 15 Oct – 4 Dec 2026: regular 09:30–16:00, extended 04:00–20:00 ET;
 *  Thanksgiving (26 Nov) closed, the day after closes at 13:00 (tape until 17:00). */
function usCalendar(): MarketWindows {
    const regular: Array<readonly [number, number]> = [];
    const extended: Array<readonly [number, number]> = [];
    for (let t = Date.UTC(2026, 9, 15); t <= Date.UTC(2026, 11, 4); t += 86_400_000) {
        const d = new Date(t);
        const wd = d.getUTCDay();
        const month = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        if (wd === 0 || wd === 6 || (month === 11 && day === 26)) continue;
        const half = month === 11 && day === 27;
        regular.push([ny(month, day, 9, 30), ny(month, day, half ? 13 : 16)]);
        extended.push([ny(month, day, 4), ny(month, day, half ? 17 : 20)]);
    }
    return { regular, extended };
}

const schedule = (now: number, windows = usCalendar(), extra: Partial<MarketSchedule> = {}): MarketSchedule => ({
    windows,
    tz: NY,
    overnight: false,
    horizon: now + 42 * 86_400_000,
    ...extra,
});

describe('formatWait', () => {
    it('rounds up to whole minutes and never reads zero', () => {
        expect(formatWait(0)).toBe('1m');
        expect(formatWait(42 * 60_000)).toBe('42m');
        expect(formatWait(59.5 * 60_000)).toBe('1h 00m');
        expect(formatWait(125 * 60_000)).toBe('2h 05m');
    });
});

describe('nextMarketEvent / marketDayAt', () => {
    it('a regular edge wins a tie with an extended one', () => {
        const same: MarketWindows = { regular: [[100, 200]], extended: [[100, 200]] };
        expect(nextMarketEvent(50, same)).toEqual({ kind: 'open', at: 100 });
        expect(nextMarketEvent(150, same)).toEqual({ kind: 'close', at: 200 });
    });

    it('focuses the day in progress, then the next one to open', () => {
        const w = usCalendar();
        expect(marketDayAt(ny(10, 21, 7, 42), w)?.regular).toEqual([ny(10, 21, 9, 30), ny(10, 21, 16)]); // pre-market
        expect(marketDayAt(ny(10, 21, 18), w)?.regular).toEqual([ny(10, 21, 9, 30), ny(10, 21, 16)]); // post-market
        expect(marketDayAt(ny(10, 24, 12), w)?.regular).toEqual([ny(10, 26, 9, 30), ny(10, 26, 16)]); // Saturday
    });

    it('drops an extended tape that only repeats the regular hours', () => {
        const same: MarketWindows = { regular: [[100, 200]], extended: [[100, 200]] };
        expect(marketDayAt(150, same)).toEqual({ regular: [100, 200], extended: null });
    });
});

describe('marketClock', () => {
    it('pre-market counts down to the open', () => {
        const now = utc(10, 21, 11, 42); // 13:42 Brussels, 07:42 ET
        const clock = marketClock(schedule(now), now, BXL)!;
        expect(clock.status).toBe('pre');
        expect(clock.text).toBe('Opens in 1h 48m');
        expect(clock.short).toBe('1h 48m');
        expect(clock.label).toBe('Pre-Market. Opens in 1h 48m');
        expect(clock.progress).toBeCloseTo(3.7 / 5.5, 2);
    });

    it('names each event in its own words', () => {
        const s = schedule(utc(10, 21, 12));
        expect(marketClock(s, ny(10, 21, 14), BXL)!.text).toBe('Closes in 2h 00m');
        expect(marketClock(s, ny(10, 21, 17), BXL)!.text).toBe('Post-market ends in 3h 00m');
        expect(marketClock(s, ny(10, 21, 23), BXL)!.text).toBe('Pre-market in 5h 00m');
        expect(marketClock(s, ny(11, 27, 12), BXL)!.text).toBe('Closes early in 1h 00m');
    });

    it('across a weekend names the day and local time instead of a long countdown', () => {
        const now = ny(10, 23, 20, 30); // Friday night, after post-market
        const clock = marketClock(schedule(now), now, BXL)!;
        expect(clock.status).toBe('closed');
        expect(clock.text).toBe('Opens Mon 14:30'); // Europe is on winter time by then
        expect(clock.short).toBe('Mon 14:30');
        expect(clock.progress).toBeNull();
    });

    it('on a holiday counts down when the next tape is under a day away', () => {
        const now = ny(11, 26, 12); // Thanksgiving noon
        const clock = marketClock(schedule(now), now, BXL)!;
        expect(clock.status).toBe('holiday');
        expect(clock.text).toBe('Pre-market in 16h 00m');
    });

    it('overnight tapes speak of extended hours, never pre- or post-market', () => {
        const now = ny(10, 21, 17);
        const clock = marketClock(schedule(now, usCalendar(), { overnight: true }), now, BXL)!;
        expect(clock.status).toBe('extended');
        expect(clock.text).toBe('Extended hours end in 3h 00m');
    });

    it('is null when nothing lies ahead', () => {
        const now = utc(12, 20, 12);
        expect(marketClock(schedule(now), now, BXL)).toBeNull();
    });
});

describe('upcomingMarketNotices', () => {
    it('finds the clock-change week, the holiday and the half day ahead', () => {
        const now = utc(10, 21, 11, 42);
        const notices = upcomingMarketNotices(now, schedule(now), BXL);
        expect(notices.map((n) => n.kind)).toEqual(['open-shift', 'holiday', 'early-close']);
        expect(notices[0]!.at).toBe(ny(10, 26, 9, 30));
        expect(notices[2]!.at).toBe(ny(11, 27, 13));
    });

    it('reports the shift back once the other region changes clocks too', () => {
        const now = utc(10, 27, 12);
        const shift = upcomingMarketNotices(now, schedule(now), BXL).find((n) => n.kind === 'open-shift');
        expect(shift?.at).toBe(ny(11, 2, 9, 30));
    });

    it('reports no open shift when the viewer shares the market clock', () => {
        const now = utc(10, 21, 11, 42);
        expect(upcomingMarketNotices(now, schedule(now), NY).some((n) => n.kind === 'open-shift')).toBe(false);
    });

    it('never calls a day past the known range a holiday', () => {
        const now = utc(10, 21, 11, 42);
        // The fetch ends at 02:00 ET on Tue 1 Dec, before that day's tape starts: the
        // provider returns nothing for it, which must not read as a holiday.
        const horizon = ny(12, 1, 2);
        const all = usCalendar();
        const fetched = { regular: all.regular.filter(([s]) => s < horizon), extended: all.extended.filter(([s]) => s < horizon) };
        const s = schedule(now, fetched, { horizon });
        const holidays = upcomingMarketNotices(now, s, BXL).filter((n) => n.kind === 'holiday');
        expect(holidays.map((n) => new Date(n.at).toISOString().slice(0, 10))).toEqual(['2026-11-26']);
    });
});

describe('marketHoursCard', () => {
    it("lays out the day in the viewer's zone with the market's own clock beside it", () => {
        const now = utc(10, 21, 11, 42);
        const card = marketHoursCard(schedule(now), now, BXL)!;
        expect(card.title).toBe('Pre-Market');
        expect(card.headline).toBe('1h 48m');
        expect(card.caption).toBe('until the market opens');
        expect(card.day).toBe('Today');
        expect(card.rows).toEqual([
            { part: 'pre', label: 'Pre-market', time: '10:00 – 15:30', nextDay: false, market: '04:00 – 09:30 EDT' },
            { part: 'open', label: 'Regular hours', time: '15:30 – 22:00', nextDay: false, market: '09:30 – 16:00 EDT' },
            { part: 'post', label: 'Post-market', time: '22:00 – 02:00', nextDay: true, market: '16:00 – 20:00 EDT' },
        ]);
        expect(card.bar.ticks.map((t) => t.label)).toEqual(['10:00', '15:30', '22:00', '02:00']);
        expect(card.bar.now).toBeCloseTo(3.7 / 16, 3);
        expect(card.zone).toBe('Europe/Brussels (UTC+2)');
        expect(card.notices).toEqual([
            { kind: 'open-shift', date: 'From Mon 26 Oct', badge: null, text: 'Opens at 14:30 as the clocks change' },
            { kind: 'holiday', date: 'Thu 26 Nov', badge: 'Closed', text: 'Market holiday' },
            { kind: 'early-close', date: 'Fri 27 Nov', badge: 'Early close', text: 'Closes at 19:00' },
        ]);
    });

    it('splits a stretch that crosses local midnight on the dial', () => {
        const now = utc(10, 21, 11, 42);
        const card = marketHoursCard(schedule(now), now, BXL)!;
        const post = card.dial.arcs.filter((a) => a.part === 'post');
        expect(post).toEqual([
            { part: 'post', from: 22 / 24, to: 1 },
            { part: 'post', from: 0, to: 2 / 24 },
        ]);
    });

    it('drops the market column when both clocks agree, and the extended rows when there is no tape', () => {
        const now = ny(10, 21, 12);
        const regularOnly = usCalendar().regular;
        const card = marketHoursCard(schedule(now, { regular: regularOnly, extended: regularOnly }), now, NY)!;
        expect(card.rows).toEqual([{ part: 'open', label: 'Regular hours', time: '09:30 – 16:00', nextDay: false, market: null }]);
    });

    it('over a weekend shows the next trading day and when it opens', () => {
        const now = ny(10, 24, 12); // Saturday noon
        const card = marketHoursCard(schedule(now), now, BXL)!;
        expect(card.status).toBe('closed');
        expect(card.day).toBe('Mon 26 Oct');
        expect(card.headline).toBe('Mon 14:30');
        expect(card.caption).toBe('next market open');
        expect(card.bar.now).toBeNull();
    });
});
