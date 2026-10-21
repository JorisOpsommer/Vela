// Market-status derivation + tracker behind the statusline's session badge: turns a
// provider's RESOLVED calendar windows (`DataProvider.getCalendar` — holidays and DST
// already applied by the source) into the badge vocabulary and keeps it current across
// session boundaries with a self-arming timer. Symbols with no calendar (crypto, a
// provider without the capability) keep the constructor's permanent 'open' — exactly
// the pre-calendar behavior.
import type { DataControl } from '../core/DataControl';
import type { MarketStatus } from './statusline';
import { parseSessionSpec } from './session-shading';

/** One `[start, end)` open window, epoch ms — the `getCalendar` wire shape. */
export type CalendarWindow = readonly [number, number];

/** The two window sets a status derivation reads: RTH and the full tape. */
export interface MarketWindows {
    regular: ReadonlyArray<CalendarWindow>;
    extended: ReadonlyArray<CalendarWindow>;
}

/** The civil date (`YYYY-MM-DD`) of `ms` in `tz`; empty string when the tz is bogus. */
export function civilDate(ms: number, tz: string): string {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms);
    } catch {
        return '';
    }
}

/** Mon–Fri in `tz`? A bogus tz answers false (never claim a holiday on bad data). */
function isWeekday(ms: number, tz: string): boolean {
    try {
        const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(ms);
        return wd !== 'Sat' && wd !== 'Sun';
    } catch {
        return false;
    }
}

/**
 * The market status at `now` given resolved windows:
 *  - inside a regular window → `open`;
 *  - inside the extended tape but outside regular hours → `extended` on overnight roll
 *    tapes (no same-day pre/post split exists); otherwise `pre` when the
 *    day's regular open still lies ahead within the SAME extended window, `post`
 *    otherwise;
 *  - otherwise closed — spelled `holiday` when a WEEKDAY (market tz) carries no
 *    extended window at all (a skipped trading day), plain `closed` for nights and
 *    weekends. A window "belongs" to the civil day its start falls on.
 */
export function deriveMarketStatus(now: number, w: MarketWindows, tz: string, overnight = false): MarketStatus {
    const within = (ws: ReadonlyArray<CalendarWindow>): CalendarWindow | undefined => ws.find(([s, e]) => now >= s && now < e);
    if (within(w.regular)) return 'open';
    const ext = within(w.extended);
    if (ext) {
        if (overnight) return 'extended';
        return w.regular.some(([s]) => s >= now && s < ext[1]) ? 'pre' : 'post';
    }
    if (isWeekday(now, tz)) {
        const today = civilDate(now, tz);
        if (today !== '' && !w.extended.some(([s]) => civilDate(s, tz) === today)) return 'holiday';
    }
    return 'closed';
}

/** The next window edge (either set) strictly after `now`, or null when none is known. */
export function nextStatusBoundary(now: number, w: MarketWindows): number | null {
    let next: number | null = null;
    for (const ws of [w.regular, w.extended]) {
        for (const [s, e] of ws) {
            for (const t of [s, e]) {
                if (t > now && (next == null || t < next)) next = t;
            }
        }
    }
    return next;
}

/** The last window edge (either set) at or before `now`, or null when none is known. */
export function prevStatusBoundary(now: number, w: MarketWindows): number | null {
    let prev: number | null = null;
    for (const ws of [w.regular, w.extended]) {
        for (const [s, e] of ws) {
            for (const t of [s, e]) {
                if (t <= now && (prev == null || t > prev)) prev = t;
            }
        }
    }
    return prev;
}

/** What a window edge means to someone waiting on the market: the regular session
 *  opening or closing, or the extended tape around it starting or ending. */
export type MarketEventKind = 'open' | 'close' | 'ext-open' | 'ext-close';

export interface MarketEvent {
    kind: MarketEventKind;
    at: number;
}

/**
 * The resolved calendar behind the status line's market clock: the windows, the market's
 * own zone (day attribution for holidays and early closes), and how far ahead the windows
 * are known — a day past `horizon` is unknown, never a holiday. Everything time-dependent
 * (status, next event, countdown) is re-derived from it at the moment of display.
 */
export interface MarketSchedule {
    windows: MarketWindows;
    tz: string;
    overnight: boolean;
    horizon: number;
}

/** The next edge strictly after `now` and what happens there. A regular edge wins a tie
 *  with an extended one (a venue whose tape starts with the bell has no pre-market). */
export function nextMarketEvent(now: number, w: MarketWindows): MarketEvent | null {
    let best: MarketEvent | null = null;
    const rank = (kind: MarketEventKind): number => (kind === 'open' || kind === 'close' ? 0 : 1);
    const consider = (at: number, kind: MarketEventKind): void => {
        if (at <= now) return;
        if (best == null || at < best.at || (at === best.at && rank(kind) < rank(best.kind))) best = { kind, at };
    };
    for (const [s, e] of w.regular) {
        consider(s, 'open');
        consider(e, 'close');
    }
    for (const [s, e] of w.extended) {
        consider(s, 'ext-open');
        consider(e, 'ext-close');
    }
    return best;
}

/** The first regular open strictly after `now`. */
export function nextRegularOpen(now: number, w: MarketWindows): number | null {
    let next: number | null = null;
    for (const [s] of w.regular) if (s > now && (next == null || s < next)) next = s;
    return next;
}

/** One trading day: its regular session and the extended tape around it (null when the
 *  venue has none, or reports the regular hours for both). */
export interface MarketDay {
    regular: CalendarWindow;
    extended: CalendarWindow | null;
}

/**
 * The trading day a viewer at `now` cares about: the one in progress (any part of its
 * tape), else the next one to open. Null when no regular session is known around `now`.
 */
export function marketDayAt(now: number, w: MarketWindows): MarketDay | null {
    const contains = ([s, e]: CalendarWindow): boolean => now >= s && now < e;
    let regular = w.regular.find(contains);
    if (!regular) {
        const ext = w.extended.find(contains);
        if (ext) {
            // Pre- or post-market: the regular session sharing this tape, nearest to now.
            const inside = w.regular.filter(([s, e]) => s < ext[1] && e > ext[0]);
            regular = inside.sort((a, b) => Math.abs(a[0] - now) - Math.abs(b[0] - now))[0];
        }
    }
    if (!regular) {
        const next = nextRegularOpen(now, w);
        regular = next == null ? undefined : w.regular.find(([s]) => s === next);
    }
    if (!regular) return null;
    const reg = regular;
    const ext = w.extended.find(([s, e]) => s <= reg[0] && e >= reg[1]);
    const extended = ext && (ext[0] !== reg[0] || ext[1] !== reg[1]) ? ext : null;
    return { regular: reg, extended };
}

/** Something about the coming weeks a viewer would otherwise miss. A holiday's `at` is
 *  noon of that day in the market's zone; an early close's is the close; an
 *  `open-shift`'s is the first open that lands at a different time of day in the
 *  viewer's zone while the market's own clock is unchanged — the two regions change
 *  clocks on different dates. */
export type MarketNotice = { kind: 'holiday'; at: number } | { kind: 'early-close'; at: number } | { kind: 'open-shift'; at: number };

/** Shortest regular-session shortfall that counts as an early close. */
const EARLY_CLOSE_MS = 30 * 60_000;

/** A regular session at least half an hour shorter than the longest one known. */
export function isEarlyClose([a, b]: CalendarWindow, w: MarketWindows): boolean {
    const longest = Math.max(...w.regular.map(([s, e]) => e - s));
    return b - a <= longest - EARLY_CLOSE_MS;
}

/** `HH:mm` of `ms` in `tz`; empty string when the tz is bogus. */
export function wallTime(ms: number, tz: string): string {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    } catch {
        return '';
    }
}

/**
 * Holidays, early closes and the first open-time shift after the trading day in focus
 * ({@link marketDayAt}), oldest first. A holiday is a market-zone weekday with no window
 * at all, reported only when the whole day lies inside the known range; an early close is
 * one {@link isEarlyClose} flags.
 */
export function upcomingMarketNotices(now: number, s: MarketSchedule, displayTz: string): MarketNotice[] {
    const { windows: w, tz, horizon } = s;
    const day = marketDayAt(now, w);
    if (!day) return [];
    const out: MarketNotice[] = [];
    const today = civilDate(now, tz);
    const traded = new Set(w.extended.concat(w.regular).map(([start]) => civilDate(start, tz)));
    const seen = new Set<string>([today]);
    for (let t = now + 86_400_000; t + 86_400_000 <= horizon; t += 86_400_000) {
        const date = civilDate(t, tz);
        if (date === '' || seen.has(date)) continue;
        seen.add(date);
        if (!isWeekday(t, tz) || traded.has(date)) continue;
        const [h, m] = wallTime(t, tz).split(':').map(Number) as [number, number];
        out.push({ kind: 'holiday', at: t + (12 * 60 - (h * 60 + m)) * 60_000 });
    }
    const later = w.regular.filter(([start]) => start > day.regular[0]).sort((a, b) => a[0] - b[0]);
    for (const win of later) if (isEarlyClose(win, w)) out.push({ kind: 'early-close', at: win[1] });
    const marketOpen = wallTime(day.regular[0], tz);
    const localOpen = wallTime(day.regular[0], displayTz);
    const shifted = later.find(([a]) => wallTime(a, tz) === marketOpen && wallTime(a, displayTz) !== localOpen);
    if (shifted && localOpen !== '') out.push({ kind: 'open-shift', at: shifted[0] });
    return out.sort((a, b) => a.at - b.at);
}

/** A window longer than this is a stand-in for "always open" (a provider answering a
 *  continuous market with the whole requested range), not a session to count down to. */
const MAX_SESSION_MS = 4 * 86_400_000;

/** How far around `now` one evaluation fetches windows — enough for the longest
 *  holiday cluster behind, and six weeks ahead so the hours card can announce the
 *  holidays, early closes and clock changes coming up. */
const FETCH_BACK_MS = 4 * 86_400_000;
const FETCH_AHEAD_MS = 42 * 86_400_000;
/** Timer clamp: at least 15 s (boundary jitter), at most an hour — the hourly
 *  re-evaluation also rolls the civil day for the holiday verdict. */
const MIN_TIMER_MS = 15_000;
const MAX_TIMER_MS = 3_600_000;
/** Retry cadence when the calendar fetch fails (the badge keeps its last state). */
const RETRY_MS = 60_000;

/**
 * Keeps ONE statusline's market badge honest: resolves the symbol's provider, reads its
 * calendar when it has one (`getCalendar` + a real session vocabulary on syminfo),
 * derives the status, and re-derives at every window boundary. Each verdict carries the
 * {@link MarketSchedule} it came from, for the market clock. `track` rebinds on any
 * symbol/chart change; `stop` ends the timers. Symbols without a calendar report a
 * permanent `'open'` with no schedule — continuous markets, and the exact legacy posture.
 */
export class MarketStatusTracker {
    /** Invalidates detached async work — bumped by every track()/stop(). */
    private epoch = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly onStatus: (status: MarketStatus, schedule: MarketSchedule | null) => void) {}

    /** (Re)bind to a chart's data surface + symbol and start evaluating. */
    track(data: DataControl, symbol: string): void {
        const my = ++this.epoch;
        this.clearTimer();
        void this.evaluate(my, data, symbol);
    }

    stop(): void {
        this.epoch += 1;
        this.clearTimer();
    }

    private async evaluate(my: number, data: DataControl, symbol: string): Promise<void> {
        const resolved = data.resolve(symbol);
        const provider = resolved ? data.providerInstance(resolved.provider) : undefined;
        const si = await data.symbolInfo(symbol).catch(() => undefined);
        if (my !== this.epoch) return;
        const hasSessions = typeof si?.session === 'string' && si.session !== '' && si.session !== '24x7';
        if (!provider?.getCalendar || !hasSessions || !resolved) {
            this.onStatus('open', null); // continuous market / no calendar — the legacy badge
            return;
        }
        const tz = typeof si?.timezone === 'string' && si.timezone !== '' ? si.timezone : 'Etc/UTC';
        const now = Date.now();
        const range = { from: now - FETCH_BACK_MS, to: now + FETCH_AHEAD_MS };
        const [regular, extended] = await Promise.all([
            provider.getCalendar(resolved.ticker, { ...range, session: 'regular' }).catch(() => null),
            provider.getCalendar(resolved.ticker, { ...range, session: 'extended' }).catch(() => null),
        ]);
        if (my !== this.epoch) return;
        if (!regular || !extended) {
            // Transient fetch failure: keep the badge as it stands and retry.
            this.arm(my, data, symbol, RETRY_MS);
            return;
        }
        const w: MarketWindows = { regular, extended };
        if (regular.some(([s, e]) => e - s > MAX_SESSION_MS)) {
            this.onStatus('open', null);
            return;
        }
        // Roll tapes (overnight `session_extended`) badge the single extended-hours
        // state — pre/post is a day-split vocabulary they don't have.
        const overnight = parseSessionSpec(si)?.overnight === true;
        this.onStatus(deriveMarketStatus(now, w, tz, overnight), { windows: w, tz, overnight, horizon: range.to });
        const boundary = nextStatusBoundary(now, w);
        const delay = Math.min(boundary != null ? boundary - now : MAX_TIMER_MS, MAX_TIMER_MS);
        this.arm(my, data, symbol, Math.max(delay, MIN_TIMER_MS));
    }

    private arm(my: number, data: DataControl, symbol: string, delay: number): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            if (my !== this.epoch) return;
            void this.evaluate(my, data, symbol);
        }, delay);
    }

    private clearTimer(): void {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = null;
    }
}
