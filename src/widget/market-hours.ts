// Market hours VIEW MODEL — the words and numbers behind the status line's market clock:
// the countdown tag beside the market badge, and the hours card (desktop) / sheet
// (phone) it opens. Derived from a resolved MarketSchedule at one instant, with every
// time written in the viewer's display zone. Pure: no DOM, no timers.
import type { MarketStatus } from './statusline';
import {
    civilDate,
    deriveMarketStatus,
    isEarlyClose,
    marketDayAt,
    nextMarketEvent,
    nextRegularOpen,
    prevStatusBoundary,
    upcomingMarketNotices,
    wallTime,
    type MarketEventKind,
    type MarketSchedule,
} from './market-status';
import { tzOffset } from '../core/timezones';

export const MARKET_STATUS_LABELS: Record<MarketStatus, string> = {
    open: 'Market Open',
    pre: 'Pre-Market',
    post: 'Post-Market',
    extended: 'Extended Hours',
    closed: 'Market Closed',
    holiday: 'Market Holiday',
};

/** Past this, a countdown reads worse than a day and a time ("Opens Mon 15:30"). */
const LONG_WAIT_MS = 24 * 3_600_000;
/** The hours card lists at most this many notices. */
const MAX_NOTICES = 3;

/** "42m", "1h 48m", "2h 05m" — whole minutes rounded UP, so the tag never reads "0m"
 *  while the event is still ahead. */
export function formatWait(ms: number): string {
    const total = Math.max(1, Math.ceil(ms / 60_000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmt(opts: Intl.DateTimeFormatOptions): (ms: number, tz: string) => string {
    return (ms, tz) => {
        try {
            return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(ms);
        } catch {
            return '';
        }
    };
}
const weekday = fmt({ weekday: 'short' });
/** "Thu 26 Nov". */
const dateLabel = fmt({ weekday: 'short', day: 'numeric', month: 'short' });

/** The zone's short name at `ms` ("EDT", "GMT+1"); empty when the tz is bogus. */
function zoneAbbr(ms: number, tz: string): string {
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
        return '';
    }
}

function closesEarly(close: number, s: MarketSchedule): boolean {
    const w = s.windows.regular.find(([, b]) => b === close);
    return w != null && isEarlyClose(w, s.windows);
}

/** What the clock counts down to, as a tag ("Opens in …") and a card caption ("until …"). */
function eventWords(kind: MarketEventKind, at: number, s: MarketSchedule): { tag: string; caption: string } {
    switch (kind) {
        case 'open':
            return { tag: 'Opens in', caption: 'until the market opens' };
        case 'close':
            return closesEarly(at, s) ? { tag: 'Closes early in', caption: 'until the early close' } : { tag: 'Closes in', caption: 'until the market closes' };
        case 'ext-open':
            return s.overnight ? { tag: 'Extended hours in', caption: 'until extended hours' } : { tag: 'Pre-market in', caption: 'until pre-market' };
        case 'ext-close':
            return s.overnight
                ? { tag: 'Extended hours end in', caption: 'until extended hours end' }
                : { tag: 'Post-market ends in', caption: 'until post-market ends' };
    }
}

/** The countdown the status line wears beside the market badge. */
export interface MarketClock {
    status: MarketStatus;
    /** The desktop tag: "Opens in 1h 48m", or "Opens Mon 15:30" across a weekend. */
    text: string;
    /** The phone pill: "1h 48m", or "Mon 15:30". */
    short: string;
    /** Status and tag together, for assistive tech. */
    label: string;
    /** How far through the current stretch (since the last edge, until the next), 0..1;
     *  null when no edge is known behind. */
    progress: number | null;
}

/** The clock at `now`, or null when no event lies ahead in the known windows. */
export function marketClock(s: MarketSchedule, now: number, displayTz: string): MarketClock | null {
    const w = s.windows;
    const status = deriveMarketStatus(now, w, s.tz, s.overnight);
    const next = nextMarketEvent(now, w);
    if (!next) return null;
    const title = MARKET_STATUS_LABELS[status];
    const open = nextRegularOpen(now, w);
    if ((status === 'closed' || status === 'holiday') && open != null && open - now >= LONG_WAIT_MS) {
        const when = `${weekday(open, displayTz)} ${wallTime(open, displayTz)}`;
        return { status, text: `Opens ${when}`, short: when, label: `${title}. Opens ${when}`, progress: null };
    }
    const wait = formatWait(next.at - now);
    const text = `${eventWords(next.kind, next.at, s).tag} ${wait}`;
    const prev = prevStatusBoundary(now, w);
    const progress = prev == null ? null : Math.min(1, Math.max(0, (now - prev) / (next.at - prev)));
    return { status, text, short: wait, label: `${title}. ${text}`, progress };
}

export type SessionPart = 'pre' | 'open' | 'post';

export interface MarketHoursRow {
    part: SessionPart;
    label: string;
    /** "10:00 – 15:30" in the viewer's zone. */
    time: string;
    /** The stretch ends on the next calendar day in the viewer's zone. */
    nextDay: boolean;
    /** The same stretch on the market's own clock ("04:00 – 09:30 EDT"); null when both
     *  clocks read the same. */
    market: string | null;
}

export interface MarketHoursNotice {
    kind: 'holiday' | 'early-close' | 'open-shift';
    /** "Thu 26 Nov", "From Mon 26 Oct". */
    date: string;
    /** "Closed", "Early close" — the short marker; null for an open-time shift. */
    badge: string | null;
    text: string;
}

/** A stretch on a 0..1 scale (the day bar's span, or the dial's 24 local hours). */
export interface MarketHoursArc {
    part: SessionPart;
    from: number;
    to: number;
}

/** Everything the hours card and the phone sheet show. */
export interface MarketHoursCard {
    status: MarketStatus;
    title: string;
    /** The big readout: "1h 48m", or "Mon 15:30" across a weekend. Null when no event is known. */
    headline: string | null;
    caption: string;
    /** Which trading day the rows describe: "Today", "Tomorrow" or "Fri 27 Nov". */
    day: string;
    rows: MarketHoursRow[];
    /** The trading day's stretches along its own span (the day bar), with the current
     *  instant on it (null when outside) and the edge times as ticks. */
    bar: { arcs: MarketHoursArc[]; now: number | null; ticks: Array<{ at: number; label: string }> };
    /** The same stretches on a 24-hour local dial (wrapping stretches split at midnight). */
    dial: { arcs: MarketHoursArc[]; now: number };
    notices: MarketHoursNotice[];
    /** "Europe/Brussels (UTC+2)". */
    zone: string;
}

const PART_LABELS: Record<SessionPart, string> = { pre: 'Pre-market', open: 'Regular hours', post: 'Post-market' };

/** Minutes into the local day of `ms`, as a 0..1 fraction. */
function dayFraction(ms: number, tz: string): number {
    const [h, m] = wallTime(ms, tz).split(':').map(Number) as [number, number];
    return Number.isFinite(h) && Number.isFinite(m) ? (h * 60 + m) / 1440 : 0;
}

/** The hours card at `now`, or null when no trading day is known around it. */
export function marketHoursCard(s: MarketSchedule, now: number, displayTz: string): MarketHoursCard | null {
    const w = s.windows;
    const day = marketDayAt(now, w);
    if (!day) return null;
    const status = deriveMarketStatus(now, w, s.tz, s.overnight);
    const t = (ms: number): string => wallTime(ms, displayTz);

    const [ro, rc] = day.regular;
    const stretches: Array<[SessionPart, number, number]> = [];
    if (day.extended && day.extended[0] < ro) stretches.push(['pre', day.extended[0], ro]);
    stretches.push(['open', ro, rc]);
    if (day.extended && day.extended[1] > rc) stretches.push(['post', rc, day.extended[1]]);
    const start = stretches[0]![1];
    const end = stretches[stretches.length - 1]![2];

    const shiftedClock = wallTime(ro, s.tz) !== t(ro);
    const abbr = zoneAbbr(ro, s.tz);
    const startDate = civilDate(start, displayTz);
    const rows = stretches.map(([part, a, b]): MarketHoursRow => ({
        part,
        label: s.overnight && part !== 'open' ? 'Extended hours' : PART_LABELS[part],
        time: `${t(a)} – ${t(b)}`,
        nextDay: civilDate(b, displayTz) !== startDate,
        market: shiftedClock ? `${wallTime(a, s.tz)} – ${wallTime(b, s.tz)}${abbr ? ` ${abbr}` : ''}` : null,
    }));

    let headline: string | null = null;
    let caption = '';
    const open = nextRegularOpen(now, w);
    const next = nextMarketEvent(now, w);
    if ((status === 'closed' || status === 'holiday') && open != null && open - now >= LONG_WAIT_MS) {
        headline = `${weekday(open, displayTz)} ${t(open)}`;
        caption = 'next market open';
    } else if (next) {
        headline = formatWait(next.at - now);
        caption = eventWords(next.kind, next.at, s).caption;
    }

    let dayText: string;
    if (now >= start || civilDate(now, displayTz) === startDate) dayText = 'Today';
    else if (civilDate(now + 86_400_000, displayTz) === startDate) dayText = 'Tomorrow';
    else dayText = dateLabel(start, displayTz);

    const span = end - start;
    const bar = {
        arcs: stretches.map(([part, a, b]) => ({ part, from: (a - start) / span, to: (b - start) / span })),
        now: now >= start && now < end ? (now - start) / span : null,
        ticks: [start, ...stretches.slice(1).map(([, a]) => a), end].map((ms) => ({ at: (ms - start) / span, label: t(ms) })),
    };
    const dialArcs: MarketHoursArc[] = [];
    for (const [part, a, b] of stretches) {
        const from = dayFraction(a, displayTz);
        const to = dayFraction(b, displayTz);
        if (b - a >= 86_400_000) dialArcs.push({ part, from: 0, to: 1 });
        else if (to > from) dialArcs.push({ part, from, to });
        else dialArcs.push({ part, from, to: 1 }, { part, from: 0, to });
    }

    const notices = upcomingMarketNotices(now, s, displayTz)
        .slice(0, MAX_NOTICES)
        .map((n): MarketHoursNotice => {
            switch (n.kind) {
                case 'holiday':
                    return { kind: n.kind, date: dateLabel(n.at, s.tz), badge: 'Closed', text: 'Market holiday' };
                case 'early-close':
                    return { kind: n.kind, date: dateLabel(n.at, displayTz), badge: 'Early close', text: `Closes at ${t(n.at)}` };
                case 'open-shift':
                    return { kind: n.kind, date: `From ${dateLabel(n.at, displayTz)}`, badge: null, text: `Opens at ${t(n.at)} as the clocks change` };
            }
        });

    return {
        status,
        title: MARKET_STATUS_LABELS[status],
        headline,
        caption,
        day: dayText,
        rows,
        bar,
        dial: { arcs: dialArcs, now: dayFraction(now, displayTz) },
        notices,
        zone: `${displayTz} (${tzOffset(displayTz, new Date(now))})`,
    };
}
