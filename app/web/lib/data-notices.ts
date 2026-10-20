// Per-symbol data notices in the top bar, shown only for the active chart's symbol:
// "Delayed N min" when the source publishes that symbol late, and the source credit for
// day-ahead power prices (their CC BY licence asks for attribution where the data shows).
import type { VelaWorkspace } from '../../../src/workspace';
import { registerWidgetAction } from '../../../src/plugin';
import { registerIcon, svg16 } from '../../../src/ui';
import type { ServerProvider } from './server-provider';

registerIcon('app-delayed', svg16('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.5"/>', 'class="app-delayed-icon"'));
registerIcon('app-source', svg16('<circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v4"/><circle cx="8" cy="5" r=".5" fill="currentColor"/>'));

const ENERGY_CHARTS_URL = 'https://energy-charts.info';

const bare = (symbol: string) => (symbol.split(':').pop() ?? '').toUpperCase();

export async function startDataNotices(ws: VelaWorkspace, provider: ServerProvider): Promise<void> {
    const rows = (await provider.listSymbols()) as Array<{ ticker: string; type?: string; delayMinutes?: number }>;
    const delays = new Map<string, number>();
    const power = new Set<string>();
    for (const r of rows) {
        if (r.delayMinutes) delays.set(r.ticker.toUpperCase(), r.delayMinutes);
        if (r.type === 'power') power.add(r.ticker.toUpperCase());
    }
    // An action's label is fixed, so each delay length gets its own action.
    for (const minutes of new Set(delays.values())) {
        registerWidgetAction({
            id: `app-delayed-${minutes}`,
            target: 'topbar',
            align: 'left',
            order: 10,
            label: `Delayed ${minutes} min`,
            icon: 'app-delayed',
            when: (ctx) => delays.get(bare(ctx.symbol)) === minutes,
            run: (ctx) => ctx.toast(`${bare(ctx.symbol)} comes from a free feed that runs ${minutes} minutes behind the market.`, 'info'),
        });
    }
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
