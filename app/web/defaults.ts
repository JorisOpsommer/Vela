// The first-visit workspace: one chart with the indicators most traders start from —
// volume, EMA 50/200 on price, and RSI 14 in its own pane — and the watchlist open.
import type { WorkspaceState } from '../../src/workspace';

export const DEFAULT_NATIVES = [
    'volume',
    { type: 'moving-average', inputs: { maType: 'EMA', length: 50, showMa2: true, ma2Type: 'EMA', ma2Length: 200 } },
    'rsi',
];

export function defaultWorkspaceState(timezone: string): WorkspaceState {
    return {
        version: 1,
        layout: '1',
        timezone,
        panels: { open: 'watchlist' },
        charts: [
            {
                id: 'c1',
                symbol: 'SPY',
                timeframe: 'D',
                priceStyle: 'candles',
                bars: 1000,
                indicators: { manifest: [], natives: DEFAULT_NATIVES },
            },
        ],
    };
}
