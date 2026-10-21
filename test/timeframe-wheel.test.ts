// @vitest-environment jsdom
// The mobile timeframe stop: a tap opens the drawer; a press and hold opens the wheel,
// a slide rolls it, the release switches — and the click that ends a hold is swallowed.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { MobileBar } from '../src/widget/mobile-bar';
import { WHEEL_HOLD_MS, WHEEL_ITEM_PX, wheelTimeframes } from '../src/widget/timeframe-wheel';
import type { WidgetContext } from '../src/widget/contributions';

if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
    (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
}

const TFS = ['1', '5', '15', '60', 'D'];

function pointer(target: HTMLElement, type: string, x: number, y: number): void {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    target.dispatchEvent(e);
}

function mount(current = '15') {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const calls = { drawer: 0, selected: [] as string[] };
    const bar = new MobileBar(host, {
        symbol: 'NYMEX:BRENT',
        timeframe: current,
        onSymbolClick: () => {},
        onTimeframeClick: () => void (calls.drawer += 1),
        onMoreClick: () => {},
        getContext: () => ({}) as WidgetContext,
        timeframeWheel: { timeframes: () => TFS, current: () => current, onSelect: (tf) => calls.selected.push(tf) },
    });
    const stop = host.querySelector<HTMLElement>('.vela-mb-tf')!;
    const tap = (): void => {
        pointer(stop, 'pointerdown', 50, 700);
        pointer(stop, 'pointerup', 50, 700);
        stop.click();
    };
    const wheel = () => host.querySelector<HTMLElement>('.vela-tfw');
    const selectedLabel = () => host.querySelector('.vela-tfw-item[data-selected]')?.textContent;
    return { host, bar, stop, calls, tap, wheel, selectedLabel };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe('wheelTimeframes', () => {
    it('orders by duration and slots in a current value the list lacks', () => {
        expect(wheelTimeframes(['D', '1', '60', '5'], '60')).toEqual(['1', '5', '60', 'D']);
        expect(wheelTimeframes(['1', '60', 'D'], '3')).toEqual(['1', '3', '60', 'D']);
    });
});

describe('timeframe stop — tap vs hold', () => {
    it('a tap opens the drawer and never the wheel', () => {
        const t = mount();
        t.tap();
        vi.advanceTimersByTime(WHEEL_HOLD_MS * 2);
        expect(t.calls.drawer).toBe(1);
        expect(t.wheel()).toBeNull();
    });

    it('a hold opens the wheel on the current timeframe; sliding up rolls to longer ones; release switches', () => {
        const t = mount('15');
        pointer(t.stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS);
        expect(t.wheel()).not.toBeNull();
        expect(t.stop.classList.contains('vela-mb-on')).toBe(true);
        expect(t.selectedLabel()).toBe('15m');

        pointer(t.stop, 'pointermove', 50, 700 - WHEEL_ITEM_PX * 2);
        vi.advanceTimersByTime(20);
        expect(t.selectedLabel()).toBe('1D');
        expect(t.host.querySelector('.vela-tfw-caption')?.textContent).toBe('1 day');

        pointer(t.stop, 'pointermove', 50, 700 - WHEEL_ITEM_PX);
        vi.advanceTimersByTime(20);
        expect(t.selectedLabel()).toBe('1h');

        pointer(t.stop, 'pointerup', 50, 700 - WHEEL_ITEM_PX);
        t.stop.click(); // the click that ends the hold
        expect(t.calls.selected).toEqual(['60']);
        expect(t.calls.drawer).toBe(0);
        expect(t.stop.classList.contains('vela-mb-on')).toBe(false);
        vi.advanceTimersByTime(300);
        expect(t.wheel()).toBeNull();

        t.tap(); // the next tap is a plain tap again
        expect(t.calls.drawer).toBe(1);
    });

    it('a vertical slide opens the wheel before the hold timer', () => {
        const t = mount('15');
        pointer(t.stop, 'pointerdown', 50, 700);
        pointer(t.stop, 'pointermove', 50, 690);
        expect(t.wheel()).not.toBeNull();
    });

    it('holding the finger below its start keeps rolling toward shorter timeframes', () => {
        const t = mount('D');
        pointer(t.stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS);
        pointer(t.stop, 'pointermove', 50, 720);
        vi.advanceTimersByTime(1000);
        expect(t.selectedLabel()).toBe('1m');
        pointer(t.stop, 'pointerup', 50, 720);
        expect(t.calls.selected).toEqual(['1']);
    });

    it('easing the finger back out of the roll keeps the item the roll stopped on', () => {
        const t = mount('D');
        pointer(t.stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS);
        pointer(t.stop, 'pointermove', 50, 720);
        vi.advanceTimersByTime(300);
        const stoppedOn = t.selectedLabel();
        expect(stoppedOn).not.toBe('1D');
        pointer(t.stop, 'pointermove', 50, 698);
        vi.advanceTimersByTime(200);
        expect(t.selectedLabel()).toBe(stoppedOn);
    });

    it('a release on the starting timeframe, or a cancelled pointer, switches nothing', () => {
        const t = mount('15');
        pointer(t.stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS);
        pointer(t.stop, 'pointerup', 50, 700);
        t.stop.click();
        expect(t.calls).toEqual({ drawer: 0, selected: [] });

        pointer(t.stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS);
        pointer(t.stop, 'pointermove', 50, 700 - WHEEL_ITEM_PX * 2);
        pointer(t.stop, 'pointercancel', 50, 700 - WHEEL_ITEM_PX * 2);
        expect(t.calls.selected).toEqual([]);
    });

    it('a stop without the wheel option only taps', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        let drawer = 0;
        new MobileBar(host, {
            symbol: 'NYMEX:BRENT',
            timeframe: '15',
            onSymbolClick: () => {},
            onTimeframeClick: () => void (drawer += 1),
            onMoreClick: () => {},
        });
        const stop = host.querySelector<HTMLElement>('.vela-mb-tf')!;
        pointer(stop, 'pointerdown', 50, 700);
        vi.advanceTimersByTime(WHEEL_HOLD_MS * 2);
        expect(host.querySelector('.vela-tfw')).toBeNull();
        stop.click();
        expect(drawer).toBe(1);
    });
});
