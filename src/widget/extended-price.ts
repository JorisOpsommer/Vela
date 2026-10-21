// The extended-hours price behind the renderer's `extendedPrice` line: while a chart shows
// the REGULAR session of a day-split market (equities: 09:30–16:00 inside a 04:00–20:00
// tape), it reads the newest bar of the symbol's EXTENDED tape and reports it as a
// pre-market or post-market price. The chart's own bars can't carry it — a regular-hours
// tape has no such bars, and a daily bar never contains them.
//
// The price follows the provider's resolved calendar: hidden while the regular session is
// open, streamed while the market is in pre/post-market, and read once while it is closed
// (nights, weekends, holidays), so the last post-market price stays up until the next
// pre-market trade replaces it.
import type { DataControl } from '../core/DataControl';
import type { Unsubscribe } from '../core/util/types';
import type { OHLCV } from '../core/model/ohlcv';
import { deriveMarketStatus, nextStatusBoundary, type CalendarWindow, type MarketWindows } from './market-status';
import { parseSessionSpec } from './session-shading';

/** One extended-hours price — the renderer's `extendedPrice` feature payload. */
export interface ExtendedPrice {
    price: number;
    session: 'pre' | 'post';
}

/**
 * The extended phase a bar opening at `t` belongs to: `pre` when the same extended window
 * still holds a regular open ahead of it, `post` when it doesn't, null inside regular
 * hours or outside every extended window.
 */
export function extendedSessionAt(t: number, w: MarketWindows): ExtendedPrice['session'] | null {
    const within = (ws: ReadonlyArray<CalendarWindow>): CalendarWindow | undefined => ws.find(([s, e]) => t >= s && t < e);
    if (within(w.regular)) return null;
    const ext = within(w.extended);
    if (!ext) return null;
    return w.regular.some(([s]) => s > t && s < ext[1]) ? 'pre' : 'post';
}

/** Windows fetched around `now`: far enough back to reach the last post-market across a
 *  long holiday weekend, and ahead to the next boundary. */
const FETCH_BACK_MS = 7 * 86_400_000;
const FETCH_AHEAD_MS = 4 * 86_400_000;
/** Bars read per one-shot fetch — only the newest one matters. */
const TAIL_BARS = 5;
/** Poll cadence in pre/post-market for providers without a live stream. */
const POLL_MS = 60_000;
/** Timer clamp, as the market-status badge: boundary jitter floor, hourly ceiling. */
const MIN_TIMER_MS = 15_000;
const MAX_TIMER_MS = 3_600_000;
const RETRY_MS = 60_000;

/**
 * Keeps ONE chart's extended-hours price current. `track` (re)binds to a symbol, `stop`
 * ends every timer and stream and clears the price. Symbols without a day-split extended
 * tape (continuous markets, overnight roll tapes, no `session_extended`) or a provider
 * without a calendar report null.
 */
export class ExtendedPriceTracker {
    /** Invalidates detached async work — bumped by every track()/stop(). */
    private epoch = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private unsubscribe: Unsubscribe | null = null;
    private last: ExtendedPrice | null = null;
    private tracked: string | null = null;

    constructor(private readonly onPrice: (price: ExtendedPrice | null) => void) {}

    /** The symbol being tracked, null when stopped. */
    get symbol(): string | null {
        return this.tracked;
    }

    /** (Re)bind to a chart's data surface + symbol. A different symbol drops the previous
     *  one's price at once; the same symbol keeps it up while re-evaluating. */
    track(data: DataControl, symbol: string): void {
        const my = ++this.epoch;
        this.teardown();
        if (symbol !== this.tracked) this.emit(null);
        this.tracked = symbol;
        void this.evaluate(my, data, symbol);
    }

    stop(): void {
        this.epoch += 1;
        this.teardown();
        this.tracked = null;
        this.emit(null);
    }

    private async evaluate(my: number, data: DataControl, symbol: string): Promise<void> {
        const resolved = data.resolve(symbol);
        const provider = resolved ? data.providerInstance(resolved.provider) : undefined;
        const si = await data.symbolInfo(symbol).catch(() => undefined);
        if (my !== this.epoch) return;
        const spec = parseSessionSpec(si);
        if (!resolved || !provider?.getCalendar || !spec || spec.overnight || typeof si?.['session_extended'] !== 'string') {
            this.emit(null);
            return;
        }
        const now = Date.now();
        const range = { from: now - FETCH_BACK_MS, to: now + FETCH_AHEAD_MS };
        const [regular, extended] = await Promise.all([
            provider.getCalendar(resolved.ticker, { ...range, session: 'regular' }).catch(() => null),
            provider.getCalendar(resolved.ticker, { ...range, session: 'extended' }).catch(() => null),
        ]);
        if (my !== this.epoch) return;
        if (!regular || !extended) {
            this.arm(my, data, symbol, RETRY_MS);
            return;
        }
        const w: MarketWindows = { regular, extended };
        const status = deriveMarketStatus(now, w, spec.timezone);
        const boundary = nextStatusBoundary(now, w);
        this.arm(my, data, symbol, Math.max(Math.min(boundary != null ? boundary - now : MAX_TIMER_MS, MAX_TIMER_MS), MIN_TIMER_MS));
        if (status === 'open') {
            this.emit(null);
            return;
        }
        const apply = (bar: OHLCV | undefined): void => {
            if (my !== this.epoch || !bar || !Number.isFinite(bar.close)) return;
            const session = extendedSessionAt(bar.time, w);
            this.emit(session ? { price: bar.close, session } : null);
        };
        const fetchTail = async (): Promise<void> => {
            const bars = await provider.getBars(resolved.ticker, '1', { limit: TAIL_BARS, session: 'extended' }).catch(() => null);
            if (bars) apply(bars[bars.length - 1]);
        };
        await fetchTail();
        if (my !== this.epoch || (status !== 'pre' && status !== 'post')) return;
        // Trading is live: follow it until the next boundary re-evaluates.
        if (provider.subscribe) {
            this.unsubscribe = provider.subscribe(resolved.ticker, '1', apply, { session: 'extended' });
        } else {
            const poll = setInterval(() => void fetchTail(), POLL_MS);
            this.unsubscribe = () => clearInterval(poll);
        }
    }

    private emit(price: ExtendedPrice | null): void {
        const prev = this.last;
        if (prev === price || (prev && price && prev.price === price.price && prev.session === price.session)) return;
        this.last = price;
        this.onPrice(price);
    }

    private arm(my: number, data: DataControl, symbol: string, delay: number): void {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (my !== this.epoch) return;
            this.teardown();
            void this.evaluate(my, data, symbol);
        }, delay);
    }

    private teardown(): void {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
