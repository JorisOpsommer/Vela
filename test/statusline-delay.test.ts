// @vitest-environment jsdom
// The status line's delayed-data tag: shown while the symbol's source publishes late,
// riding with the market badge (its part toggle, and hidden during a replay).
import { describe, it, expect } from 'vitest';
import { Statusline } from '../src/widget/statusline';

// jsdom ships no CSS.escape; the kit's style injection needs it for its id lookup.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

function make() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const line = new Statusline(host, 'NYMEX:BRENT');
    const tag = line.el.querySelector<HTMLElement>('.vela-sl-delay')!;
    return { line, tag };
}

describe('Statusline delayed-data tag', () => {
    it('is absent for real-time data and reads "Delayed Nm" once a delay is set', () => {
        const { line, tag } = make();
        expect(tag.style.display).toBe('none');

        line.setDelay(10);
        expect(tag.style.display).toBe('');
        expect(tag.textContent).toBe('Delayed 10m');
        expect(tag.querySelector('svg')).not.toBeNull(); // the clock glyph
        // Directly after the market badge, inside the identity row.
        expect(tag.previousElementSibling?.classList.contains('vela-sl-market')).toBe(true);

        line.setDelay(0);
        expect(tag.style.display).toBe('none');
        line.setDelay(null);
        expect(tag.style.display).toBe('none');
        line.destroy();
    });

    it('hides with the market part and during a replay, and comes back after', () => {
        const { line, tag } = make();
        line.setDelay(15);

        line.setPartVisible('market', false);
        expect(tag.style.display).toBe('none');
        line.setPartVisible('market', true);
        expect(tag.style.display).toBe('');

        line.setReplaying(true); // a past bar's "now" is not delayed
        expect(tag.style.display).toBe('none');
        line.setReplaying(false);
        expect(tag.style.display).toBe('');
        line.destroy();
    });

    it('ignores nonsense delays', () => {
        const { line, tag } = make();
        line.setDelay(-5);
        expect(tag.style.display).toBe('none');
        line.setDelay(Number.NaN);
        expect(tag.style.display).toBe('none');
        line.destroy();
    });
});
