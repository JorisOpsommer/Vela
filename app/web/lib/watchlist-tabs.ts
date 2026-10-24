// Tabs hold groups. A saved watchlist from before tabs has no tab list: its groups land in one tab.
// Kept apart from the DOM so the rules can be tested alone.

export const DEFAULT_TAB = 'Watchlist';

export interface TabbedGroup {
    name: string;
    tab?: string;
}

/**
 * Returns the tab list and the groups with a valid tab on each. Tabs keep their saved order;
 * a group that names a tab missing from the list adds that tab; a group without a tab goes to
 * the first one. A watchlist always has at least one tab.
 */
export function settleTabs<G extends TabbedGroup>(saved: { tabs?: readonly string[]; groups: readonly G[] }): { tabs: string[]; groups: G[] } {
    const tabs: string[] = [];
    for (const t of saved.tabs ?? []) if (t && !tabs.includes(t)) tabs.push(t);
    for (const g of saved.groups) if (g.tab && !tabs.includes(g.tab)) tabs.push(g.tab);
    if (tabs.length === 0) tabs.push(DEFAULT_TAB);
    return { tabs, groups: saved.groups.map((g) => ({ ...g, tab: g.tab && tabs.includes(g.tab) ? g.tab : tabs[0] })) };
}
