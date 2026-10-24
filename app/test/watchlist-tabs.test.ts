import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB, settleTabs, type TabbedGroup } from '../web/lib/watchlist-tabs';

const settle = (saved: { tabs?: string[]; groups: TabbedGroup[] }) => settleTabs(saved);

describe('settleTabs', () => {
    it('puts a saved watchlist without tabs into one tab', () => {
        const r = settle({ groups: [{ name: 'Main' }, { name: 'Interested' }] });
        expect(r.tabs).toEqual([DEFAULT_TAB]);
        expect(r.groups.map((g) => g.tab)).toEqual([DEFAULT_TAB, DEFAULT_TAB]);
    });

    it('keeps the saved tab order and an empty tab', () => {
        const r = settle({ tabs: ['Stocks', 'Crypto'], groups: [{ name: 'Main', tab: 'Stocks' }] });
        expect(r.tabs).toEqual(['Stocks', 'Crypto']);
        expect(r.groups[0]!.tab).toBe('Stocks');
    });

    it('adds a tab that a group names but the list lacks, and sends a tab-less group to the first tab', () => {
        const r = settle({ tabs: ['Stocks'], groups: [{ name: 'A', tab: 'Crypto' }, { name: 'B' }] });
        expect(r.tabs).toEqual(['Stocks', 'Crypto']);
        expect(r.groups.map((g) => g.tab)).toEqual(['Crypto', 'Stocks']);
    });

    it('drops duplicate and empty tab names', () => {
        expect(settle({ tabs: ['Crypto', '', 'Crypto'], groups: [] }).tabs).toEqual(['Crypto']);
        expect(settle({ tabs: [], groups: [] }).tabs).toEqual([DEFAULT_TAB]);
    });
});
