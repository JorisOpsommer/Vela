// Timeframe wheel (mobile) — press and hold the bottom bar's timeframe stop, slide the
// finger up or down to roll a drum of timeframes, release to switch. The stop keeps the
// pointer captured for the whole gesture, so the wheel itself never takes a touch
// (`pointer-events: none`): every move arrives on the stop and drives the drum here.
//
// Finger up rolls toward LONGER timeframes (the drum follows the finger, shortest at
// the top). The stop sits at the screen's bottom edge, so there is almost no room to
// slide down: a finger held past its starting point keeps the drum rolling toward
// shorter timeframes until it comes back up.
import { injectStyles } from '../ui/styles';
import { parseTimeframe, timeframeLabel, timeframeMs } from './timeframe';

const STYLE_ID = 'vela-widget-tf-wheel';
/** Hold this long before the wheel opens (a vertical slide opens it sooner). */
export const WHEEL_HOLD_MS = 280;
/** Vertical travel that opens the wheel before the hold timer does. */
const SLIDE_OPEN_PX = 8;
/** Sideways travel (before the wheel opens) that abandons the gesture. */
const ABANDON_PX = 14;
/** Finger travel per item. */
export const WHEEL_ITEM_PX = 34;
/** Degrees of drum per item, and the drum radius that keeps an item WHEEL_ITEM_PX tall. */
const STEP_DEG = 20;
const RADIUS = WHEEL_ITEM_PX / ((STEP_DEG * Math.PI) / 180);
/** Past the start point (or near the host's top), the drum keeps rolling — once the
 *  finger has rested there a moment (a slip does not roll), slowly at first. */
const ROLL_ZONE_PX = 14;
const ROLL_DELAY_MS = 300;
const ROLL_START_ITEMS_PER_S = 2.5;
const ROLL_MAX_ITEMS_PER_S = 6;
/** Items per second the roll gains for each second it runs. */
const ROLL_RAMP = 4;
const EDGE_PX = 28;
/** How far the drum may stretch past either end before it stops following. */
const OVERSCROLL = 0.45;

const CSS = `
.vela-tfw-backdrop {
    position: absolute;
    inset: 0;
    background: var(--vela-backdrop);
    opacity: 0;
    pointer-events: none;
    z-index: var(--vela-z-popover);
    transition: opacity var(--vela-dur-fast) var(--vela-ease);
}
.vela-tfw-backdrop[data-open] { opacity: 0.55; }
.vela-tfw {
    position: absolute;
    width: 132px;
    padding: 10px 0 8px;
    box-sizing: border-box;
    background: var(--vela-surface-elev);
    color: var(--vela-fg);
    border: 1px solid var(--vela-border-strong);
    border-radius: 16px;
    box-shadow: var(--vela-shadow-dialog);
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    z-index: var(--vela-z-popover);
    transform-origin: 50% 100%;
    opacity: 0;
    transform: translateY(10px) scale(0.92);
    transition: opacity 140ms var(--vela-ease), transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.vela-tfw[data-open] { opacity: 1; transform: none; }
.vela-tfw-drum {
    position: relative;
    height: ${Math.round(2 * RADIUS * Math.sin((70 * Math.PI) / 180) + WHEEL_ITEM_PX)}px;
    perspective: 520px;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(transparent, #000 22%, #000 78%, transparent);
    mask-image: linear-gradient(transparent, #000 22%, #000 78%, transparent);
}
.vela-tfw-band {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 50%;
    height: ${WHEEL_ITEM_PX}px;
    margin-top: ${-WHEEL_ITEM_PX / 2}px;
    border-radius: 9px;
    background: var(--vela-hover-strong);
}
.vela-tfw-item {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: ${WHEEL_ITEM_PX}px;
    margin-top: ${-WHEEL_ITEM_PX / 2}px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--vela-fg-muted);
    backface-visibility: hidden;
    will-change: transform, opacity;
}
.vela-tfw-item[data-selected] { color: var(--vela-fg-bright); }
.vela-tfw-caption {
    margin-top: 6px;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--vela-fg-muted);
    white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
    .vela-tfw, .vela-tfw-backdrop { transition: none; }
    .vela-tfw { transform: none; }
}
`;

/** The list the wheel rolls through: the configured timeframes in duration order, with
 *  the current one slotted in when it is not among them (a custom typed value). */
export function wheelTimeframes(timeframes: readonly string[], current: string): string[] {
    const list = [...new Set(timeframes)];
    if (!list.includes(current)) list.push(current);
    return list
        .map((tf, i) => ({ tf, i, ms: timeframeMs(tf) }))
        .sort((a, b) => {
            const aOk = Number.isFinite(a.ms);
            const bOk = Number.isFinite(b.ms);
            if (aOk && bOk && a.ms !== b.ms) return a.ms - b.ms;
            if (aOk !== bOk) return aOk ? -1 : 1;
            return a.i - b.i;
        })
        .map((e) => e.tf);
}

/** "15 minutes", "4 hours", "1 day" — the caption under the drum. */
function longLabel(tf: string): string {
    const p = parseTimeframe(timeframeLabel(tf));
    return p.valid ? p.label! : tf;
}

export interface TimeframeWheelOptions {
    /** The shell root (positioned) — the wheel mounts here, inside the theme variables. */
    host: HTMLElement;
    timeframes: () => readonly string[];
    current: () => string;
    /** A release on a different timeframe. */
    onSelect: (tf: string) => void;
    /** The gesture took over the stop (true) or let it go (false). */
    onActiveChange?: (active: boolean) => void;
}

/**
 * Binds the hold gesture to `stop`. A short tap stays a plain click; {@link consumeClick}
 * tells the stop's click handler whether the click that follows a release belongs to a
 * finished hold (and must be ignored).
 */
export class TimeframeWheel {
    private readonly doc: Document;
    private readonly backdrop: HTMLElement;
    private readonly card: HTMLElement;
    private readonly drum: HTMLElement;
    private readonly caption: HTMLElement;
    private items: HTMLElement[] = [];
    private list: string[] = [];

    private pointerId: number | null = null;
    private startX = 0;
    private startY = 0;
    private lastY = 0;
    private holdTimer: ReturnType<typeof setTimeout> | null = null;
    private open = false;
    private swallowClick = false;
    /** Index of the item under the band when the finger sits at `anchorY`. */
    private anchorPos = 0;
    private anchorY = 0;
    private pos = 0;
    /** What the drum shows: eases after `pos` and leans into the nearest item, so the
     *  drum moves smoothly and settles on each item like a detent. */
    private shown = 0;
    private rolling = false;
    /** When the finger entered the roll zone (frame time), or null outside it. */
    private zoneSince: number | null = null;
    /** The finger's travel counts only inside the host: a finger that slides off the
     *  app (onto the browser's toolbar) moves the drum no further. */
    private bounds = { top: -Infinity, bottom: Infinity };
    private selected = -1;
    private initial = -1;
    private raf = 0;
    private lastFrame = 0;
    private closeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly listeners: Array<[string, EventListener]> = [];

    constructor(
        private readonly stop: HTMLElement,
        private readonly opts: TimeframeWheelOptions,
    ) {
        this.doc = opts.host.ownerDocument;
        injectStyles(STYLE_ID, CSS, this.doc);
        this.backdrop = this.doc.createElement('div');
        this.backdrop.className = 'vela-tfw-backdrop vela-ui-layer';
        this.card = this.doc.createElement('div');
        this.card.className = 'vela-tfw vela-ui-layer';
        this.card.setAttribute('role', 'listbox');
        this.card.setAttribute('aria-label', 'Timeframe');
        this.drum = this.doc.createElement('div');
        this.drum.className = 'vela-tfw-drum';
        const band = this.doc.createElement('div');
        band.className = 'vela-tfw-band';
        this.drum.appendChild(band);
        this.caption = this.doc.createElement('div');
        this.caption.className = 'vela-tfw-caption';
        this.card.append(this.drum, this.caption);

        const on = (type: string, fn: (e: PointerEvent) => void): void => {
            const l = fn as EventListener;
            stop.addEventListener(type, l);
            this.listeners.push([type, l]);
        };
        on('pointerdown', (e) => this.down(e));
        on('pointermove', (e) => this.move(e));
        on('pointerup', (e) => this.up(e));
        on('pointercancel', (e) => this.end(e, false));
        on('lostpointercapture', (e) => this.end(e, false));
        // Android's long-press menu fires around the time the wheel opens.
        on('contextmenu', (e) => e.preventDefault());
    }

    get isOpen(): boolean {
        return this.open;
    }

    /** True once for the click that follows a finished hold (the stop ignores it). */
    consumeClick(): boolean {
        const s = this.swallowClick;
        this.swallowClick = false;
        return s;
    }

    /** Close without switching (layout flip, teardown). */
    cancel(): void {
        this.finish(false);
    }

    destroy(): void {
        this.finish(false);
        for (const [type, l] of this.listeners) this.stop.removeEventListener(type, l);
        if (this.closeTimer) clearTimeout(this.closeTimer);
        this.backdrop.remove();
        this.card.remove();
    }

    private down(e: PointerEvent): void {
        if (this.pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        this.swallowClick = false;
        this.pointerId = e.pointerId;
        this.startX = e.clientX;
        this.startY = this.lastY = e.clientY;
        this.stop.setPointerCapture?.(e.pointerId);
        this.holdTimer = setTimeout(() => this.show(), WHEEL_HOLD_MS);
    }

    private move(e: PointerEvent): void {
        if (e.pointerId !== this.pointerId) return;
        this.lastY = e.clientY;
        if (this.open) {
            this.track();
            return;
        }
        const dx = Math.abs(e.clientX - this.startX);
        const dy = Math.abs(e.clientY - this.startY);
        if (dy >= SLIDE_OPEN_PX && dy > dx) this.show();
        else if (dx >= ABANDON_PX) this.release();
    }

    private up(e: PointerEvent): void {
        if (e.pointerId !== this.pointerId) return;
        this.end(e, true);
    }

    private end(e: PointerEvent, commit: boolean): void {
        if (e.pointerId !== this.pointerId) return;
        this.finish(commit);
    }

    private finish(commit: boolean): void {
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        const wasOpen = this.open;
        const tf = this.list[this.selected];
        const changed = wasOpen && commit && this.selected !== this.initial && tf !== undefined;
        this.release();
        if (!wasOpen) return;
        this.swallowClick = true;
        this.hide();
        if (changed) this.opts.onSelect(tf);
    }

    /** Drop the pointer (the gesture is over, or it became something else). */
    private release(): void {
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        const id = this.pointerId;
        this.pointerId = null;
        if (id !== null && this.stop.hasPointerCapture?.(id)) this.stop.releasePointerCapture(id);
    }

    private show(): void {
        if (this.open || this.pointerId === null) return;
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        if (this.closeTimer) clearTimeout(this.closeTimer);
        this.closeTimer = null;
        const current = this.opts.current();
        this.list = wheelTimeframes(this.opts.timeframes(), current);
        if (this.list.length === 0) return;
        this.open = true;
        this.initial = this.selected = Math.max(0, this.list.indexOf(current));
        this.anchorPos = this.pos = this.shown = this.initial;
        const host = this.opts.host.getBoundingClientRect();
        const view = this.doc.defaultView;
        this.bounds = host.height > 0 ? { top: host.top, bottom: host.bottom } : { top: 0, bottom: view?.innerHeight ?? Infinity };
        this.anchorY = this.y();
        this.rolling = false;
        this.zoneSince = null;

        for (const el of this.items) el.remove();
        this.items = this.list.map((tf) => {
            const el = this.doc.createElement('div');
            el.className = 'vela-tfw-item';
            el.setAttribute('role', 'option');
            el.textContent = timeframeLabel(tf);
            this.drum.appendChild(el);
            return el;
        });
        this.opts.host.append(this.backdrop, this.card);
        this.place();
        this.paint();
        this.markSelected();
        // Next frame: the entry transition needs the closed state painted first.
        requestAnimationFrame(() => {
            if (!this.open) return;
            this.card.dataset.open = '';
            this.backdrop.dataset.open = '';
        });
        this.opts.onActiveChange?.(true);
        this.lastFrame = 0;
        this.raf = requestAnimationFrame((t) => this.frame(t));
    }

    private hide(): void {
        this.open = false;
        cancelAnimationFrame(this.raf);
        delete this.card.dataset.open;
        delete this.backdrop.dataset.open;
        this.opts.onActiveChange?.(false);
        this.closeTimer = setTimeout(() => {
            this.closeTimer = null;
            if (this.open) return;
            this.backdrop.remove();
            this.card.remove();
        }, 200);
    }

    /** Above the stop, centered on it, kept inside the host. */
    private place(): void {
        const host = this.opts.host.getBoundingClientRect();
        const stop = this.stop.getBoundingClientRect();
        const width = this.card.offsetWidth || 132;
        const center = stop.left + stop.width / 2 - host.left;
        const left = Math.min(Math.max(8, center - width / 2), Math.max(8, host.width - width - 8));
        this.card.style.left = `${Math.round(left)}px`;
        this.card.style.bottom = `${Math.round(host.bottom - stop.top + 10)}px`;
    }

    /** Follow the finger: one item per WHEEL_ITEM_PX of travel, re-anchored at the ends
     *  so a reversal answers at once instead of after the overshoot is undone. */
    private track(): void {
        const max = this.list.length - 1;
        let pos = this.anchorPos + (this.anchorY - this.y()) / WHEEL_ITEM_PX;
        if (pos > max + OVERSCROLL || pos < -OVERSCROLL) {
            pos = Math.min(max + OVERSCROLL, Math.max(-OVERSCROLL, pos));
            this.anchorPos = pos;
            this.anchorY = this.y();
        }
        this.pos = pos;
    }

    private y(): number {
        return Math.min(this.bounds.bottom, Math.max(this.bounds.top, this.lastY));
    }

    /** Rolling while the finger sits past its start point (no room left below) or
     *  against the host's top edge. */
    private frame(t: number): void {
        if (!this.open) return;
        const dt = this.lastFrame ? Math.min(0.05, (t - this.lastFrame) / 1000) : 0;
        this.lastFrame = t;
        const y = this.y();
        const zone = y > this.startY + ROLL_ZONE_PX ? -1 : y < this.bounds.top + EDGE_PX ? 1 : 0;
        if (zone === 0) this.zoneSince = null;
        else this.zoneSince ??= t;
        const held = this.zoneSince === null ? 0 : t - this.zoneSince - ROLL_DELAY_MS;
        const dir = held >= 0 ? zone : 0;
        if (dir === 0 && this.rolling) {
            // The finger leaves the roll zone: hold the item the roll stopped on, so
            // the small move it takes to stop rolling never steps one item further.
            this.anchorPos = this.pos = this.selected;
            this.anchorY = y;
        }
        this.rolling = dir !== 0;
        if (dir !== 0 && dt > 0) {
            const rate = Math.min(ROLL_MAX_ITEMS_PER_S, ROLL_START_ITEMS_PER_S + (ROLL_RAMP * held) / 1000);
            this.anchorPos += dir * rate * dt;
            this.track();
        } else if (dir === 0) {
            // Ease a stretched drum back inside the ends while the finger rests.
            const max = this.list.length - 1;
            const clamped = Math.min(max, Math.max(0, this.pos));
            if (clamped !== this.pos && dt > 0) {
                const next = this.pos + (clamped - this.pos) * Math.min(1, dt * 12);
                this.anchorPos += next - this.pos;
                this.pos = next;
            }
        }
        this.markSelected();
        const max = this.list.length - 1;
        const near = Math.min(max, Math.max(0, Math.round(this.pos)));
        const target = this.rolling ? this.pos : near + (this.pos - near) * 0.32;
        this.shown = dt > 0 ? this.shown + (target - this.shown) * Math.min(1, dt * 22) : target;
        this.paint();
        this.raf = requestAnimationFrame((n) => this.frame(n));
    }

    private paint(): void {
        for (let i = 0; i < this.items.length; i++) {
            const el = this.items[i]!;
            const d = i - this.shown;
            const deg = d * STEP_DEG;
            if (Math.abs(deg) > 84) {
                el.style.visibility = 'hidden';
                continue;
            }
            const rad = (deg * Math.PI) / 180;
            el.style.visibility = '';
            el.style.transform = `translateY(${(RADIUS * Math.sin(rad)).toFixed(2)}px) translateZ(${(RADIUS * (Math.cos(rad) - 1)).toFixed(2)}px) rotateX(${(-deg).toFixed(2)}deg)`;
            el.style.opacity = Math.max(0.15, 1 - Math.abs(d) * 0.24).toFixed(3);
        }
    }

    private markSelected(): void {
        const max = this.list.length - 1;
        const next = Math.min(max, Math.max(0, Math.round(this.pos)));
        const el = this.items[next];
        if (next === this.selected && el?.hasAttribute('data-selected')) return;
        const changed = next !== this.selected;
        this.items[this.selected]?.removeAttribute('data-selected');
        this.items[this.selected]?.setAttribute('aria-selected', 'false');
        this.selected = next;
        el?.setAttribute('data-selected', '');
        el?.setAttribute('aria-selected', 'true');
        this.caption.textContent = longLabel(this.list[next] ?? '');
        if (changed) {
            try {
                (this.doc.defaultView?.navigator as Navigator | undefined)?.vibrate?.(6);
            } catch {
                // Haptics are a nicety; some browsers throw outside a user gesture.
            }
        }
    }
}
