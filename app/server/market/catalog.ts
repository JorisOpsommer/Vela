// The symbol catalog: configured instruments (indices, futures, FX, crypto, power) from
// tickers.json, plus every US-listed equity from the broker's asset list. Each entry says
// which bridges can serve it, in fallback order.
import fs from 'node:fs';
import path from 'node:path';
import type { AssetClass, CatalogEntry, SourceRef } from './types';
import type { AlpacaAsset } from './bridges/alpaca';

interface InstrumentSpec {
    name: string;
    class: AssetClass;
    prefix: string;
    currency: string;
    timezone: string;
    session: string;
    decimals?: number;
    yahoo?: string;
    coinbase?: string;
    alpaca?: string;
    energycharts?: string;
    finnhubLive?: string;
    usCalendar?: boolean;
}

export interface TickerConfig {
    groups: Array<{ name: string; symbols: string[] }>;
    instruments: Record<string, InstrumentSpec>;
}

export interface WatchlistGroup {
    name: string;
    symbols: string[];
}

const US_SESSION = '0930-1600';
const US_EXTENDED = '0400-2000';

/** Listing exchange as the broker names it → the venue prefix users recognise. */
const EXCHANGE_PREFIX: Record<string, string> = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', ARCA: 'ARCA', AMEX: 'AMEX', BATS: 'CBOE', OTC: 'OTC' };

export function loadTickerConfig(configDir: string): TickerConfig {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'tickers.json'), 'utf8')) as TickerConfig;
    if (!Array.isArray(raw.groups) || typeof raw.instruments !== 'object') throw new Error('tickers.json: expected { groups, instruments }');
    return raw;
}

/** `NASDAQ:AAPL` / `market:aapl` → `AAPL`. */
export function bareSymbol(s: string): string {
    const i = s.lastIndexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toUpperCase();
}

/** Yahoo spells share classes with a dash (`BRK-A`). */
export function yahooEquityTicker(symbol: string): string {
    return symbol.replace(/\./g, '-');
}

export function equityEntry(symbol: string, name: string, exchange: string | null, hasAlpaca: boolean, hasFinnhub: boolean): CatalogEntry {
    const sources: SourceRef[] = [];
    if (hasAlpaca) sources.push({ bridge: 'alpaca', ticker: symbol });
    sources.push({ bridge: 'yahoo', ticker: yahooEquityTicker(symbol) });
    return {
        symbol,
        name,
        class: 'stock',
        prefix: (exchange && EXCHANGE_PREFIX[exchange]) ?? 'US',
        sources,
        ...(hasFinnhub ? { live: { bridge: 'finnhub', ticker: symbol } as SourceRef } : {}),
        currency: 'USD',
        timezone: 'America/New_York',
        session: US_SESSION,
    };
}

function instrumentEntry(symbol: string, spec: InstrumentSpec, has: { alpaca: boolean; finnhub: boolean }): CatalogEntry {
    const sources: SourceRef[] = [];
    if (spec.coinbase) sources.push({ bridge: 'coinbase', ticker: spec.coinbase });
    if (spec.alpaca && has.alpaca) sources.push({ bridge: 'alpaca', ticker: spec.alpaca });
    if (spec.yahoo) sources.push({ bridge: 'yahoo', ticker: spec.yahoo });
    if (spec.energycharts) sources.push({ bridge: 'energycharts', ticker: spec.energycharts });
    return {
        symbol,
        name: spec.name,
        class: spec.class,
        prefix: spec.prefix,
        sources,
        ...(spec.finnhubLive && has.finnhub ? { live: { bridge: 'finnhub', ticker: spec.finnhubLive } as SourceRef } : {}),
        currency: spec.currency,
        timezone: spec.timezone,
        session: spec.session,
        ...(spec.decimals != null ? { decimals: spec.decimals } : {}),
    };
}

export class Catalog {
    private readonly entries = new Map<string, CatalogEntry>();
    private readonly usCalendar = new Set<string>();
    private equities: CatalogEntry[] = [];

    constructor(readonly config: TickerConfig, private readonly has: { alpaca: boolean; finnhub: boolean }) {
        for (const [sym, spec] of Object.entries(config.instruments)) {
            this.entries.set(sym.toUpperCase(), instrumentEntry(sym.toUpperCase(), spec, has));
            if (spec.usCalendar) this.usCalendar.add(sym.toUpperCase());
        }
    }

    /** Merge the broker's equity list (names, listing venues). Configured instruments win. */
    setAssets(assets: AlpacaAsset[]): void {
        const list: CatalogEntry[] = [];
        for (const a of assets) {
            const sym = a.symbol.toUpperCase();
            const e = equityEntry(sym, a.name, a.exchange, this.has.alpaca, this.has.finnhub);
            list.push(e);
            if (!this.entries.has(sym) || this.entries.get(sym)!.class === 'stock') this.entries.set(sym, e);
        }
        this.equities = list;
    }

    /** Resolve a user-typed symbol (`AAPL`, `nasdaq:aapl`, `BRK.A`). */
    resolve(raw: string): CatalogEntry | null {
        const sym = raw.trim().toUpperCase().replace(/^[A-Z ]+:/, '');
        if (!/^[A-Z0-9.^=/-]{1,20}$/.test(sym)) return null;
        const hit = this.entries.get(sym);
        if (hit) return hit;
        // Unknown but plausible equity ticker (asset list not loaded yet): try the bridges.
        if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) return equityEntry(sym, sym, null, this.has.alpaca, this.has.finnhub);
        return null;
    }

    /** True for instruments that follow the US exchange calendar (sessions, holidays). */
    followsUsCalendar(entry: CatalogEntry): boolean {
        return entry.class === 'stock' || entry.class === 'etf' || this.usCalendar.has(entry.symbol);
    }

    sessionExtended(entry: CatalogEntry): string | undefined {
        return entry.class === 'stock' || entry.class === 'etf' ? US_EXTENDED : undefined;
    }

    /** Everything searchable: configured instruments first, then equities. */
    all(): CatalogEntry[] {
        const configured = [...this.entries.values()].filter((e) => e.class !== 'stock');
        const seen = new Set(configured.map((e) => e.symbol));
        const watch = this.defaultGroups().flatMap((g) => g.symbols);
        const out = [...configured];
        for (const s of watch) {
            const e = this.resolve(s);
            if (e && !seen.has(e.symbol)) {
                out.push(e);
                seen.add(e.symbol);
            }
        }
        for (const e of this.equities) if (!seen.has(e.symbol)) out.push(e);
        return out;
    }

    defaultGroups(): WatchlistGroup[] {
        return this.config.groups.map((g) => ({ name: g.name, symbols: g.symbols.map((s) => s.toUpperCase()) }));
    }
}
