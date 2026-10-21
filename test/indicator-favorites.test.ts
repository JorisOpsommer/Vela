// @vitest-environment jsdom
// Starred indicators: the picker lists them first, alphabetically, out of their category;
// a star click never adds the indicator; a starred row still adds the study it names; and
// the set rides `getState()` / `applyState()` so a reload keeps it.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

import { VelaWorkspace } from '../src/workspace/VelaWorkspace';
import { IndicatorPicker, indicatorFavoriteKey, type IndicatorRow } from '../src/widget/indicator-picker';

beforeAll(() => {
    Element.prototype.animate ??= (() => ({ cancel() {}, finish() {}, addEventListener() {} })) as unknown as Element['animate'];
});

const settled = () => new Promise<void>((r) => setTimeout(r, 50));

const live: Array<{ destroy(): void }> = [];
afterEach(() => {
    for (const x of live.splice(0)) x.destroy();
    document.body.replaceChildren();
});

const LIBRARY: IndicatorRow[] = [
    { name: 'Moving Average', category: 'Built-in', native: true, nativeType: 'sma' },
    { name: 'RSI', category: 'Built-in', native: true, nativeType: 'rsi' },
    { name: 'Volume', category: 'Built-in', native: true, nativeType: 'volume' },
    { name: 'Awesome Script', category: 'Scripts' },
];

/** Group titles and row names, top to bottom. */
function listing(root: ParentNode): string[] {
    return [...root.querySelectorAll('.vela-ip-list > .vela-ip-group, .vela-ip-list > .vela-ip-row')].map((el) =>
        el.classList.contains('vela-ip-group') ? `# ${el.textContent}` : el.querySelector('.vela-ip-name')!.textContent!,
    );
}

function rowByName(root: ParentNode, name: string): HTMLElement {
    return [...root.querySelectorAll<HTMLElement>('.vela-ip-list > .vela-ip-row')].find((r) => r.querySelector('.vela-ip-name')!.textContent === name)!;
}

async function mountPicker(favorites: string[]) {
    const added: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const picker = new IndicatorPicker({
        host,
        library: () => LIBRARY,
        onChart: () => [],
        onAdd: (i) => added.push(i),
        onRemove: () => undefined,
        favorites: () => favorites,
        onFavorite: (key, on) => {
            const at = favorites.indexOf(key);
            if (on && at < 0) favorites.push(key);
            if (!on && at >= 0) favorites.splice(at, 1);
        },
    });
    live.push(picker);
    picker.open();
    await settled();
    return { host, added, favorites };
}

describe('indicator favorites in the picker', () => {
    it('lists starred indicators first, alphabetically, and takes them out of their category', async () => {
        const { host } = await mountPicker(['native:volume', 'script:Awesome Script']);
        expect(listing(host)).toEqual(['# Favorites', 'Awesome Script', 'Volume', '# Built-in', 'Moving Average', 'RSI']);
    });

    it('clicking a star toggles the favorite without adding the indicator', async () => {
        const { host, added, favorites } = await mountPicker([]);
        expect(listing(host)[0]).toBe('# Built-in');
        rowByName(host, 'RSI').querySelector<HTMLElement>('.vela-ip-star')!.click();
        expect(added).toEqual([]);
        expect(favorites).toEqual(['native:rsi']);
        expect(listing(host).slice(0, 2)).toEqual(['# Favorites', 'RSI']);
        expect(rowByName(host, 'RSI').querySelector('.vela-ip-star')!.getAttribute('aria-pressed')).toBe('true');

        rowByName(host, 'RSI').querySelector<HTMLElement>('.vela-ip-star')!.click();
        expect(favorites).toEqual([]);
        expect(listing(host)).not.toContain('# Favorites');
    });

    it('a starred row adds the indicator at its original library index', async () => {
        const { host, added } = await mountPicker(['native:volume']);
        rowByName(host, 'Volume').click();
        expect(added).toEqual([2]);
    });

    it('shows no stars when the host does not handle them', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const picker = new IndicatorPicker({ host, library: () => LIBRARY, onChart: () => [], onAdd: () => undefined, onRemove: () => undefined });
        live.push(picker);
        picker.open();
        await settled();
        expect(host.querySelectorAll('.vela-ip-row').length).toBe(LIBRARY.length);
        expect(host.querySelector('.vela-ip-star')).toBeNull();
    });

    it('keys natives by type and scripts by name', () => {
        expect(indicatorFavoriteKey(LIBRARY[1]!)).toBe('native:rsi');
        expect(indicatorFavoriteKey(LIBRARY[3]!)).toBe('script:Awesome Script');
    });
});

describe('indicator favorites in a workspace', () => {
    function mountWorkspace(opts: Record<string, unknown>): VelaWorkspace {
        const host = document.createElement('div');
        document.body.append(host);
        const ws = new VelaWorkspace(host, opts as never);
        live.push(ws);
        return ws;
    }

    it('a star from the picker rides getState and comes back on applyState', async () => {
        const first = mountWorkspace({ layout: '1' });
        await settled(); // the built-in catalog resolves asynchronously
        const rows = first.active.libraryRows();
        const target = rows.find((r) => r.native && r.nativeType === 'rsi')!;
        expect(target).toBeDefined();
        (first as unknown as { indicatorPicker: IndicatorPicker }).indicatorPicker.open();
        await settled();
        const before = first.active.onChartRows().length;
        rowByName(document, target.name).querySelector<HTMLElement>('.vela-ip-star')!.click();
        expect(first.active.onChartRows().length).toBe(before);
        const saved = JSON.parse(JSON.stringify(first.getState()));
        expect(saved.indicatorFavorites).toEqual(['native:rsi']);
        first.destroy();
        document.body.replaceChildren();

        const second = mountWorkspace({ layout: '1' });
        second.applyState(saved);
        await settled();
        (second as unknown as { indicatorPicker: IndicatorPicker }).indicatorPicker.open();
        await settled();
        expect(listing(document).slice(0, 2)).toEqual(['# Favorites', target.name]);
        const types = second.active.onChartRows().map((r) => r.nativeType);
        rowByName(document, target.name).click();
        expect(second.active.onChartRows().map((r) => r.nativeType)).toEqual([...types, 'rsi']);
    });
});
