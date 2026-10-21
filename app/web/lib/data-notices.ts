// The source credit for day-ahead power prices in the top bar, shown only while a power
// symbol is open: their CC BY licence asks for attribution where the data shows. (A
// delayed feed is marked by the chart's own status line, from `delay_minutes`.)
import type { VelaWorkspace } from '../../../src/workspace';
import { registerWidgetAction } from '../../../src/plugin';
import { registerIcon, svg16 } from '../../../src/ui';
import type { ServerProvider } from './server-provider';

registerIcon('app-source', svg16('<circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v4"/><circle cx="8" cy="5" r=".5" fill="currentColor"/>'));

const ENERGY_CHARTS_URL = 'https://energy-charts.info';

const bare = (symbol: string) => (symbol.split(':').pop() ?? '').toUpperCase();

export async function startDataNotices(ws: VelaWorkspace, provider: ServerProvider): Promise<void> {
    const rows = (await provider.listSymbols()) as Array<{ ticker: string; type?: string }>;
    const power = new Set(rows.filter((r) => r.type === 'power').map((r) => r.ticker.toUpperCase()));
    registerWidgetAction({
        id: 'app-source-energy',
        target: 'topbar',
        align: 'left',
        order: 10,
        label: 'Energy-Charts.info · CC BY 4.0',
        icon: 'app-source',
        when: (ctx) => power.has(bare(ctx.symbol)),
        run: () => window.open(ENERGY_CHARTS_URL, '_blank', 'noopener,noreferrer'),
    });

    // `when` gates are read when the top bar renders, which a symbol switch inside the
    // active chart does not trigger on its own.
    let shown = '';
    const sync = () => {
        const symbol = bare(ws.active.symbol);
        if (symbol === shown) return;
        shown = symbol;
        ws.refreshActions();
    };
    ws.on('state:changed', sync);
    ws.on('cell:active', sync);
    sync();
}
