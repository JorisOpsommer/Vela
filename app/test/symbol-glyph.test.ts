import { describe, expect, it } from 'vitest';
import { glyphSvg, symbolGlyph } from '../web/lib/symbol-glyph';

describe('symbolGlyph', () => {
    it('splits an FX pair into its two currency signs', () => {
        const svg = glyphSvg({ ticker: 'EURUSD', type: 'forex', description: 'Euro / U.S. Dollar' });
        expect(svg).toContain('>€</text>');
        expect(svg).toContain('>$</text>');
    });

    it('draws commodities by what they are, not by their ticker', () => {
        const brent = glyphSvg({ ticker: 'BRENT', type: 'futures', description: 'Brent Crude Oil Futures' });
        const wti = glyphSvg({ ticker: 'WTI', type: 'futures', description: 'WTI Crude Oil Futures' });
        const ttf = glyphSvg({ ticker: 'TTF', type: 'futures', description: 'Dutch TTF Natural Gas Futures (EUR/MWh)' });
        const gold = glyphSvg({ ticker: 'GOLD', type: 'futures', description: 'Gold Futures' });
        const power = glyphSvg({ ticker: 'BELPEX', type: 'power', description: 'Belgium Day-Ahead Power Price (EUR/MWh)' });
        expect(brent).toBe(wti);
        expect(ttf).not.toBe(brent);
        expect(gold).toContain('>Au</text>');
        expect(new Set([brent, ttf, gold, power]).size).toBe(4);
    });

    it('gives each ticker its own stable badge', () => {
        const spy = glyphSvg({ ticker: 'SPY', type: 'etf' });
        expect(spy).toContain('>SPY</text>');
        expect(glyphSvg({ ticker: 'SPY', type: 'etf' })).toBe(spy);
        expect(glyphSvg({ ticker: 'QQQ', type: 'etf' })).not.toBe(spy.replace('SPY', 'QQQ'));
        expect(glyphSvg({ ticker: 'NI225', type: 'index' })).toContain('>NI</text>');
        expect(glyphSvg({ ticker: 'SOLUSD', type: 'crypto' })).toContain('>SOL</text>');
        expect(glyphSvg({ ticker: 'BRK.A', type: 'stock' })).toContain('>BRK</text>');
    });

    it('keeps markup-significant characters out of the label', () => {
        expect(glyphSvg({ ticker: '<b>&"x' })).toContain('>BX</text>');
    });

    it('returns a fully encoded data URI', () => {
        const uri = symbolGlyph({ ticker: 'EURUSD', type: 'forex' });
        expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
        expect(uri.slice('data:image/svg+xml,'.length)).not.toMatch(/[#<>"]/);
    });
});
