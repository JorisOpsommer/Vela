// Generated symbol icons for instruments without a logo (FX pairs, commodities, indices,
// power, and any stock or coin whose logo lookup misses). Pure and offline: each icon is a
// self-contained SVG `data:` URI, so gradient ids never collide between rows and the same
// string works anywhere an <img> does.

export interface GlyphSymbol {
    ticker: string;
    /** Asset class as the catalog names it (`stock`, `forex`, `futures`, …). */
    type?: string | null;
    /** Display name; commodities are recognised by it rather than by their ticker. */
    description?: string | null;
}

interface Currency {
    sign: string;
    color: string;
}

const CURRENCIES: Record<string, Currency> = {
    USD: { sign: '$', color: '#1f8a5b' },
    EUR: { sign: '€', color: '#2f5bd3' },
    GBP: { sign: '£', color: '#7b3fb8' },
    JPY: { sign: '¥', color: '#d0343c' },
    CNY: { sign: '¥', color: '#c2410c' },
    CHF: { sign: 'F', color: '#b91c1c' },
    AUD: { sign: 'A', color: '#0e7490' },
    CAD: { sign: 'C', color: '#be123c' },
    NZD: { sign: 'N', color: '#334155' },
};

const FONT = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="central"`;

const cache = new Map<string, string>();

/** The generated icon for `s`, as a `data:image/svg+xml` URI. */
export function symbolGlyph(s: GlyphSymbol): string {
    const key = `${s.type ?? ''}|${s.ticker}|${s.description ?? ''}`;
    let uri = cache.get(key);
    if (!uri) {
        uri = `data:image/svg+xml,${encodeURIComponent(glyphSvg(s))}`;
        cache.set(key, uri);
    }
    return uri;
}

/** The raw SVG markup behind {@link symbolGlyph}. */
export function glyphSvg(s: GlyphSymbol): string {
    const ticker = s.ticker.toUpperCase().replace(/^.*:/, '');
    const name = (s.description ?? '').toLowerCase();
    const type = s.type ?? '';

    if (type === 'forex') {
        const pair = /^([A-Z]{3})\/?([A-Z]{3})$/.exec(ticker);
        if (pair) return forex(pair[1]!, pair[2]!);
    }
    if (type === 'power') return bolt();
    if (type === 'futures' || type === 'commodity') {
        if (/crude|\boil\b|brent|\bwti\b/.test(name + ' ' + ticker.toLowerCase())) return oilDrop();
        if (/natural gas|\bgas\b|\bttf\b/.test(name)) return flame();
        const metal = METALS.find((e) => e.match.test(name));
        if (metal) return metalTile(metal);
    }
    if (type === 'index') {
        if (/volatility/.test(name)) return pulse();
        if (/dollar index/.test(name)) return disc(['#2bb673', '#13693f'], text(CURRENCIES.USD!.sign, 19));
    }
    return badge(ticker, type);
}

function disc(stops: [string, string], body: string): string {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${stops[0]}"/><stop offset="1" stop-color="${stops[1]}"/></linearGradient></defs>` +
        `<circle cx="16" cy="16" r="16" fill="url(#g)"/>${body}</svg>`
    );
}

function text(label: string, size: number, x = 16, y = 16, fill = '#fff'): string {
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${FONT}>${label}</text>`;
}

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

/** A pair split along the diagonal: base currency top-left, quote currency bottom-right. */
function forex(base: string, quote: string): string {
    const cur = (code: string): Currency => CURRENCIES[code] ?? { sign: code[0]!, color: `hsl(${hash(code) % 360} 55% 42%)` };
    const a = cur(base);
    const b = cur(quote);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
        `<path d="M27.31 4.69A16 16 0 0 0 4.69 27.31Z" fill="${a.color}"/>` +
        `<path d="M27.31 4.69A16 16 0 0 1 4.69 27.31Z" fill="${b.color}"/>` +
        `<path d="M27.31 4.69L4.69 27.31" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/>` +
        text(a.sign, 12, 11, 12) +
        text(b.sign, 12, 21, 20.5) +
        `</svg>`
    );
}

function oilDrop(): string {
    return disc(
        ['#f6c453', '#d4870f'],
        `<path d="M16 5.5C16 5.5 9 14.2 9 19a7 7 0 0 0 14 0C23 14.2 16 5.5 16 5.5Z" fill="#17181c"/>` + `<ellipse cx="13.2" cy="19.6" rx="1.4" ry="2.4" fill="#fff" fill-opacity=".35"/>`,
    );
}

function flame(): string {
    return disc(
        ['#1e40af', '#0b1640'],
        `<path d="M16 5c1.5 4.5 6.5 7 6.5 13.5a6.5 6.5 0 0 1-13 0c0-3 1.6-5 3.2-6.4 0 2 .8 3.4 2.2 3.9C14.4 12.2 15.2 8.6 16 5Z" fill="#60a5fa"/>` +
            `<path d="M16 15c1.4 2 3 3.2 3 5.3a3 3 0 0 1-6 0c0-2.1 1.6-3.3 3-5.3Z" fill="#e0f2fe"/>`,
    );
}

function bolt(): string {
    return disc(['#4338ca', '#1e1b4b'], `<path d="M18.5 4.5L9 18h6.2L13 27.5 23 13.5h-6.3Z" fill="#facc15"/>`);
}

function pulse(): string {
    return disc(['#f97316', '#be123c'], `<path d="M5 17h4.5l2.8-7 4.4 13 3-9 1.8 3H27" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
}

interface Metal {
    match: RegExp;
    symbol: string;
    stops: [string, string];
    ink: string;
}

const METALS: Metal[] = [
    { match: /\bgold\b/, symbol: 'Au', stops: ['#fde68a', '#b7791f'], ink: '#4a3206' },
    { match: /\bsilver\b/, symbol: 'Ag', stops: ['#f1f5f9', '#94a3b8'], ink: '#1e293b' },
    { match: /\bplatinum\b/, symbol: 'Pt', stops: ['#e2e8f0', '#64748b'], ink: '#0f172a' },
    { match: /\bpalladium\b/, symbol: 'Pd', stops: ['#e7e5e4', '#78716c'], ink: '#1c1917' },
    { match: /\bcopper\b/, symbol: 'Cu', stops: ['#fdba74', '#b45309'], ink: '#431407' },
];

function metalTile(e: Metal): string {
    return disc(e.stops, text(e.symbol, 13, 16, 16.5, e.ink));
}

/** The default: the ticker's letters on a gradient whose hue is derived from the ticker. */
function badge(ticker: string, type: string): string {
    // Share classes (`BRK.A`) badge as their company; coins as their base asset.
    const root = ticker.split(/[.\-/]/)[0] || ticker;
    const base = type === 'crypto' ? root.replace(/(USDT|USDC|USD|EUR|BTC)$/, '') || root : root;
    const letters = base.replace(/[^A-Z]/g, '');
    const alnum = base.replace(/[^A-Z0-9]/g, '');
    const label = letters.length > 0 && letters.length <= 3 ? letters : (letters || alnum).slice(0, 2) || '?';
    const hue = hash(base) % 360;
    return disc([`hsl(${hue} 70% 56%)`, `hsl(${(hue + 40) % 360} 65% 36%)`], text(label, label.length >= 3 ? 11 : 14, 16, 16.5));
}
