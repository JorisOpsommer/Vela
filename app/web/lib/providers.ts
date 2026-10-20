// Display names for the server's market-data sources, shared by every page that names one.

export const PROVIDERS: Record<string, { name: string; role: string }> = {
    alpaca: { name: 'Alpaca', role: 'US stocks & ETFs · calendar · search' },
    finnhub: { name: 'Finnhub', role: 'Live trades · logos · fallback quotes' },
    yahoo: { name: 'Yahoo Finance', role: 'Indices · futures · FX' },
    energycharts: { name: 'Energy-Charts', role: 'Belgian day-ahead power · Fraunhofer ISE, CC BY 4.0' },
    coinbase: { name: 'Coinbase', role: 'Crypto candles & stream' },
};

export function providerName(id: string): string {
    return PROVIDERS[id]?.name ?? id;
}
