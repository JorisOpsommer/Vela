// The chart app: a Vela workspace on the server's data provider, with the account's
// saved layout restored before first paint and a watchlist panel docked on the right.
import { VelaWorkspace } from '../../src/workspace';
import { registerSidePanel, registerWidgetAction } from '../../src/plugin';
import { registerIcon, svg16 } from '../../src/ui';
import { loadMe, logout } from './lib/api';
import { createServerStorage } from './lib/storage';
import { ServerProvider } from './lib/server-provider';
import { watchlistPanel } from './watchlist';
import { defaultWorkspaceState } from './defaults';
import { startTracker } from './lib/tracker';
import { showProviderLimit } from './lib/toast';
import { startDataNotices } from './lib/data-notices';
import './app.css';

const WORKSPACE_KEY = 'workspace';

registerIcon('app-watchlist', svg16('<path d="M5 4h8M5 8h8M5 12h8"/><circle cx="2.5" cy="4" r=".6" fill="currentColor"/><circle cx="2.5" cy="8" r=".6" fill="currentColor"/><circle cx="2.5" cy="12" r=".6" fill="currentColor"/>'));
registerIcon('app-account', svg16('<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5"/>'));
registerIcon('app-stats', svg16('<path d="M2.5 13.5h11"/><path d="M4 11V8M7 11V4.5M10 11V6.5M13 11V3"/>'));
registerIcon('app-insights', svg16('<path d="M8 1.8l1.6 3.6 3.9.4-2.9 2.6.8 3.8L8 10.3l-3.4 1.9.8-3.8L2.5 5.8l3.9-.4z"/>'));
registerIcon('app-logout', svg16('<path d="M6 3H3.5v10H6M10 5l3 3-3 3M13 8H6.5"/>'));

async function main(): Promise<void> {
    const me = await loadMe();
    if (me.mustChangePassword) {
        location.href = '/account';
        return;
    }
    const storage = await createServerStorage([WORKSPACE_KEY, 'watchlist']);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
    // First visit: a starter layout with the common indicators. Seeded, not saved —
    // nothing is written until the user changes something.
    if (storage.wasEmpty(WORKSPACE_KEY)) storage.seed(WORKSPACE_KEY, JSON.stringify(defaultWorkspaceState(timezone)));

    const provider = new ServerProvider({ onProviderLimit: showProviderLimit });
    registerSidePanel(watchlistPanel(storage, provider));
    registerWidgetAction({ id: 'app-insights', target: 'topbar', label: 'My insights', icon: 'app-insights', iconOnly: true, order: 880, run: () => (location.href = '/insights') });
    registerWidgetAction({ id: 'app-stats', target: 'topbar', label: 'Data providers', icon: 'app-stats', iconOnly: true, order: 890, run: () => (location.href = '/stats') });
    registerWidgetAction({ id: 'app-account', target: 'topbar', label: `Account (${me.username})`, icon: 'app-account', iconOnly: true, order: 900, run: () => (location.href = '/account') });
    registerWidgetAction({ id: 'app-logout', target: 'topbar', label: 'Sign out', icon: 'app-logout', iconOnly: true, order: 910, run: () => void logout() });

    const ws = new VelaWorkspace('#app', {
        layout: '1',
        symbol: 'SPY',
        timeframe: 'D',
        bars: 1000,
        live: true,
        theme: 'dark',
        timezone,
        autofocus: true,
        persist: WORKSPACE_KEY,
        storage,
        providers: { market: () => provider },
    });
    window.addEventListener('pagehide', () => storage.flush());
    // Links from the Insights page open a symbol: /?symbol=NVDA.
    const linked = new URLSearchParams(location.search).get('symbol');
    if (linked && /^[A-Za-z0-9.:^=/ -]{1,40}$/.test(linked)) {
        ws.active.setSymbol(linked);
        history.replaceState(null, '', '/');
    }
    startTracker(ws);
    void startDataNotices(ws, provider);
    (window as unknown as { vela?: unknown }).vela = ws;
}

main().catch((err: unknown) => {
    console.error(err);
    const box = document.getElementById('app');
    if (box) box.innerHTML = '<p class="boot-error">Could not load the app. Reload the page to try again.</p>';
});
