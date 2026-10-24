// The options page: the account's watchlist at a glance, then one symbol in depth — where
// open interest sits, what the market prices for the coming move, where dealer hedging
// may pin or push the price, and what holding the stock takes in margin.
import './pages.css';
import './options.css';
import { api, ApiError, loadMe } from './lib/api';
import { mountNav } from './lib/nav';
import { startMarketBell } from './lib/market-bell';
import { symbolGlyph } from './lib/symbol-glyph';
import { fmt, h, SERIES } from './lib/viz';
import { compact, strikeBars, xyLines, type RefLine } from './lib/option-charts';

interface Summary {
    date: string;
    oiDate: string | null;
    spot: number;
    callOI: number;
    putOI: number;
    pcrOI: number | null;
    callVolume: number;
    putVolume: number;
    pcrVolume: number | null;
    iv30: number | null;
    skew25: number | null;
    expectedMove: { expiry: string; days: number; amount: number; pct: number } | null;
    maxPain: { expiry: string; strike: number } | null;
    netGex: number | null;
    gammaFlip: number | null;
    callWall: number | null;
    putWall: number | null;
    contracts: number;
    quoted: number;
    feedGreeks: number | null;
}

interface StrikeRow {
    strike: number;
    callOI: number;
    putOI: number;
    callGex: number;
    putGex: number;
}

interface ContractRow {
    occ: string;
    right: 'C' | 'P';
    expiry: string;
    strike: number;
    oi: number;
    volume: number;
    iv: number | null;
    mid: number | null;
    ratio?: number;
    premium?: number;
}

interface Detail {
    strikes: StrikeRow[];
    expiries: Array<{ expiry: string; days: number; callOI: number; putOI: number; atmIV: number | null; maxPain: number | null; move: number | null }>;
    smile: { expiry: string; points: Array<{ strike: number; callIV: number | null; putIV: number | null }> } | null;
    gexCurve: Array<{ price: number; gex: number }>;
    unusual: ContractRow[];
    topOI: ContractRow[];
}

interface Terms {
    marginable: boolean;
    marginLong: number | null;
    marginShort: number | null;
    maintenance: number | null;
    shortable: boolean;
    easyToBorrow: boolean;
    hasOptions: boolean;
}

interface Rank {
    rank: number;
    days: number;
}

interface WatchRow {
    symbol: string;
    name: string;
    summary: Summary | null;
    previous: Summary | null;
    ivRank: Rank | null;
    terms: Terms | null;
}

interface SymbolView {
    symbol: string;
    name: string;
    read: { fetchedAt: number; summary: Summary; detail: Detail };
    previousStrikes: StrikeRow[] | null;
    previousDate: string | null;
    history: Array<{ date: string; spot: number; callOI: number; putOI: number; pcrOI: number | null; iv30: number | null }>;
    ivRank: Rank | null;
    terms: Terms | null;
}

const CALL = SERIES[0]!;
const PUT = SERIES[1]!;
const $ = (id: string) => document.getElementById(id)!;
const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${fmt(v * 100, digits)}%`);
const money = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `$${fmt(v, digits)}`);
const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), digits)}`;
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

let view: SymbolView | null = null;
let oiMode: 'level' | 'change' = 'level';

function logo(symbol: string): HTMLElement {
    const box = h('span', 'logo');
    const img = h('img');
    img.alt = '';
    img.src = symbolGlyph({ ticker: symbol, type: 'stock', description: symbol });
    const remote = new Image();
    remote.onload = () => (img.src = remote.src);
    remote.src = `/api/logo/${encodeURIComponent(symbol)}`;
    box.append(img);
    return box;
}

/** "Long gamma" or "Short gamma", with what it tends to mean for the price. */
function gammaRegime(netGex: number | null): { label: string; hint: string; cls: string } | null {
    if (netGex == null) return null;
    return netGex >= 0
        ? { label: 'Long gamma', hint: 'dealer hedging tends to damp moves', cls: 'long' }
        : { label: 'Short gamma', hint: 'dealer hedging tends to extend moves', cls: 'short' };
}

function table(head: Array<string | [string, boolean]>, rows: HTMLElement[]): HTMLElement {
    const wrap = h('div', 'table-wrap');
    const t = h('table', 'data');
    const tr = h('tr');
    for (const c of head) {
        const [label, num] = typeof c === 'string' ? [c, false] : c;
        tr.append(h('th', num ? 'num' : '', label));
    }
    const thead = h('thead');
    thead.append(tr);
    const tbody = h('tbody');
    tbody.append(...rows);
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
}

function cell(text: string, cls = ''): HTMLTableCellElement {
    return h('td', cls, text);
}

// ── Watchlist overview ─────────────────────────────────────────────────────
async function loadWatchlist(): Promise<WatchRow[]> {
    const res = await api<{ available: boolean; rows: WatchRow[] }>('/api/options/watchlist');
    const host = $('watchlist');
    if (!res.available) {
        host.replaceChildren(h('div', 'empty', 'Options data needs the Alpaca keys on this server.'));
        return [];
    }
    if (res.rows.length === 0) {
        host.replaceChildren(h('div', 'empty', 'No stocks or ETFs in your watchlist. Pick any symbol below to read its options.'));
        return [];
    }
    const rows = res.rows.map((r) => {
        const tr = h('tr', 'clickable');
        tr.tabIndex = 0;
        const s = r.summary;
        const name = h('td', 'sym');
        name.append(logo(r.symbol), h('b', '', r.symbol), h('span', 'nm', r.name));
        tr.append(name);
        if (!s) {
            const td = cell('Read after the close — select to read now', 'muted');
            td.colSpan = 8;
            tr.append(td);
        } else {
            const p = r.previous;
            const oi = s.callOI + s.putOI;
            const prevOI = p ? p.callOI + p.putOI : null;
            const g = gammaRegime(s.netGex);
            tr.append(
                cell(money(s.spot), 'num'),
                cell(fmt(s.pcrOI, 2), 'num'),
                cell(prevOI ? `${signed(((oi - prevOI) / prevOI) * 100)}%` : '—', 'num'),
                cell(pct(s.iv30), 'num'),
                cell(r.ivRank ? `${fmt(r.ivRank.rank * 100)}` : '—', 'num'),
                cell(s.expectedMove ? `±${pct(s.expectedMove.pct)}` : '—', 'num'),
                cell(s.maxPain ? money(s.maxPain.strike, s.maxPain.strike % 1 ? 1 : 0) : '—', 'num'),
            );
            const gt = h('td');
            if (g) gt.append(h('span', `regime ${g.cls}`, g.label));
            tr.append(gt);
        }
        const terms = r.terms;
        tr.append(cell(terms?.marginable ? `${fmt(terms.marginLong)}% / ${terms.shortable ? `${fmt(terms.marginShort)}%` : 'no short'}` : terms ? 'Cash only' : '—', 'num'));
        const open = () => void showSymbol(r.symbol, true);
        tr.onclick = open;
        tr.onkeydown = (e) => {
            if (e.key === 'Enter') open();
        };
        return tr;
    });
    host.replaceChildren(
        table(['Symbol', ['Price', true], ['Put/call OI', true], ['OI change', true], ['IV 30d', true], ['IV rank', true], ['Expected move', true], ['Max pain', true], 'Dealer gamma', ['Margin long / short', true]], rows),
    );
    const read = res.rows.find((r) => r.summary)?.summary;
    $('wl-note').textContent = read ? `read ${day(read.date)} · open interest as of ${read.oiDate ? day(read.oiDate) : '—'}` : '';
    return res.rows;
}

// ── One symbol ─────────────────────────────────────────────────────────────
async function showSymbol(symbol: string, scroll = false): Promise<void> {
    const detail = $('detail');
    detail.hidden = false;
    $('d-symbol').textContent = symbol;
    $('d-name').textContent = 'Reading the option chain…';
    $('d-logo').replaceChildren(logo(symbol));
    $('d-asof').textContent = '';
    detail.classList.add('loading');
    history.replaceState(null, '', `/options?symbol=${encodeURIComponent(symbol)}`);
    if (scroll) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
        view = await api<SymbolView>(`/api/options/symbol/${encodeURIComponent(symbol)}`);
    } catch (err) {
        view = null;
        $('d-name').textContent = err instanceof ApiError ? err.message : 'Could not read the option chain.';
        $('d-kpis').replaceChildren();
        detail.classList.add('failed');
        detail.classList.remove('loading');
        return;
    }
    detail.classList.remove('loading', 'failed');
    renderSymbol(view);
}

function kpi(label: string, value: string, hint: string, extra?: HTMLElement): HTMLElement {
    const c = h('div', 'card kpi fade-in');
    c.append(h('div', 'label', label), h('div', 'value', value), h('div', 'hint', hint));
    if (extra) c.append(extra);
    return c;
}

function renderSymbol(v: SymbolView): void {
    const s = v.read.summary;
    const d = v.read.detail;
    $('d-symbol').textContent = v.symbol;
    const open = h('a', 'chip', 'Open chart');
    open.href = `/?symbol=${encodeURIComponent(v.symbol)}`;
    $('d-name').replaceChildren(document.createTextNode(`${v.name} · ${money(s.spot)} `), open);
    $('d-asof').textContent = `Read ${new Date(v.read.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · open interest as of ${s.oiDate ? day(s.oiDate) : '—'} · ${fmt(s.contracts)} contracts, ${fmt(s.quoted)} quoted · indicative data`;

    const g = gammaRegime(s.netGex);
    const gTag = g ? h('span', `regime ${g.cls}`, g.label) : undefined;
    const prevOI = v.history.length >= 2 ? v.history[v.history.length - 2]! : null;
    const oiNow = s.callOI + s.putOI;
    $('d-kpis').replaceChildren(
        kpi('Open interest', compact(oiNow), prevOI ? `${signed(((oiNow - prevOI.callOI - prevOI.putOI) / (prevOI.callOI + prevOI.putOI)) * 100)}% since ${day(prevOI.date)}` : `${compact(s.callOI)} calls · ${compact(s.putOI)} puts`),
        kpi('Put/call ratio', fmt(s.pcrOI, 2), `open interest · volume ${fmt(s.pcrVolume, 2)}`),
        kpi('Implied volatility', pct(s.iv30), v.ivRank ? `30-day · IV rank ${fmt(v.ivRank.rank * 100)} over ${v.ivRank.days} days` : '30-day · rank builds with history'),
        kpi('Expected move', s.expectedMove ? `±${money(s.expectedMove.amount)}` : '—', s.expectedMove ? `±${pct(s.expectedMove.pct)} by ${day(s.expectedMove.expiry)} (1σ)` : 'no at-the-money quote'),
        kpi('Max pain', s.maxPain ? money(s.maxPain.strike, s.maxPain.strike % 1 ? 2 : 0) : '—', s.maxPain ? `${day(s.maxPain.expiry)} expiry · ${signed(((s.maxPain.strike - s.spot) / s.spot) * 100)}% from price` : ''),
        kpi('Dealer gamma', s.netGex != null ? `${s.netGex < 0 ? '−' : ''}$${compact(Math.abs(s.netGex))}` : '—', g ? `${g.hint}${s.gammaFlip != null ? ` · flips at ${money(s.gammaFlip)}` : ''}` : 'no greeks quoted', gTag),
        kpi('Skew', s.skew25 != null ? `${signed(s.skew25 * 100)} pts` : '—', s.skew25 == null ? '25-delta, ~30 days' : s.skew25 > 0 ? 'puts priced richer — downside hedged' : 'calls priced richer — upside chased'),
    );

    const levels: RefLine[] = [{ at: s.spot, label: `Price ${fmt(s.spot, 2)}`, strong: true }];
    if (s.callWall != null) levels.push({ at: s.callWall, label: `Call wall ${fmt(s.callWall, 0)}` });
    if (s.putWall != null) levels.push({ at: s.putWall, label: `Put wall ${fmt(s.putWall, 0)}` });
    if (s.maxPain) levels.push({ at: s.maxPain.strike, label: `Max pain ${fmt(s.maxPain.strike, 0)}` });
    renderOI(v, levels);

    $('oi-sub').textContent = `all expiries within 90 days · ±25% of price`;
    strikeBars($('gex-chart'), d.strikes.map((r) => ({ strike: r.strike, up: r.callGex, down: r.putGex })), {
        upLabel: 'Calls (dealers long)',
        downLabel: 'Puts (dealers short)',
        upColor: CALL,
        downColor: PUT,
        signed: true,
        lines: levels.filter((l) => !l.label.startsWith('Max pain')),
        tip: (r) => [
            { label: 'Calls', value: `$${compact(r.up)}`, color: CALL },
            { label: 'Puts', value: `−$${compact(Math.abs(r.down))}`, color: PUT },
            { label: 'Net', value: `${r.up + r.down < 0 ? '−' : ''}$${compact(Math.abs(r.up + r.down))}` },
        ],
    });

    const flipLines: RefLine[] = [{ at: s.spot, label: 'Price', strong: true }];
    if (s.gammaFlip != null) flipLines.push({ at: s.gammaFlip, label: `Flip ${fmt(s.gammaFlip, 2)}` });
    xyLines($('flip-chart'), [{ label: 'Net dealer gamma', color: SERIES[2]!, points: d.gexCurve.map((p) => [p.price, p.gex] as const) }], {
        xFmt: (x) => fmt(x, 0),
        xHead: (x) => `If the price were ${money(x)}`,
        yFmt: (y) => `${y < 0 ? '−' : ''}$${compact(Math.abs(y))}`,
        lines: flipLines,
        zero: true,
        fill: true,
    });
    $('flip-explain').textContent =
        s.gammaFlip == null
            ? 'Dealer gamma keeps one sign across ±15% of the price.'
            : s.spot >= s.gammaFlip
              ? `Above ${money(s.gammaFlip)} dealers are estimated long gamma: they sell rallies and buy dips, which tends to calm the price. Below it the hedging flips and can speed moves up.`
              : `Below ${money(s.gammaFlip)} dealers are estimated short gamma: they chase the price, which can speed moves up. Above it the hedging turns calming.`;

    xyLines($('term-chart'), [{ label: 'At-the-money IV', color: SERIES[0]!, points: d.expiries.filter((e) => e.atmIV != null).map((e) => [e.days, e.atmIV] as const) }], {
        xFmt: (x) => `${fmt(x, 0)}d`,
        xHead: (x) => {
            const e = d.expiries.find((q) => q.days === x);
            return e ? `${day(e.expiry)} · ${fmt(x, 0)} days · ±${money(e.move)}` : `${fmt(x, 0)} days`;
        },
        yFmt: (y) => pct(y, 0),
    });

    $('smile-sub').textContent = d.smile ? `${day(d.smile.expiry)} expiry` : '';
    xyLines(
        $('smile-chart'),
        d.smile
            ? [
                  { label: 'Calls', color: CALL, points: d.smile.points.map((p) => [p.strike, p.callIV] as const) },
                  { label: 'Puts', color: PUT, points: d.smile.points.map((p) => [p.strike, p.putIV] as const) },
              ]
            : [],
        { xFmt: (x) => fmt(x, 0), xHead: (x) => `Strike ${fmt(x, 2)}`, yFmt: (y) => pct(y, 0), lines: [{ at: s.spot, label: 'Price', strong: true }] },
    );
    if (!d.smile) $('smile-chart').replaceChildren(h('div', 'empty', 'No quoted strikes for the monthly expiry.'));

    renderRisk(v);
    renderContracts($('unusual'), d.unusual, true);
    renderContracts($('top-oi'), d.topOI, false);
    renderHistory(v);
}

function renderOI(v: SymbolView, levels: RefLine[]): void {
    const strikes = v.read.detail.strikes;
    const prev = new Map((v.previousStrikes ?? []).map((r) => [r.strike, r]));
    const changeBtn = document.querySelector<HTMLButtonElement>('#oi-mode [data-mode="change"]')!;
    changeBtn.disabled = !v.previousStrikes;
    changeBtn.title = v.previousStrikes ? `Against the read of ${day(v.previousDate!)}` : 'Needs a second day of reads';
    if (!v.previousStrikes) oiMode = 'level';
    for (const b of document.querySelectorAll<HTMLButtonElement>('#oi-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === oiMode));
    const tip = (r: { strike: number }) => {
        const now = strikes.find((q) => q.strike === r.strike)!;
        const p = prev.get(r.strike);
        return [
            { label: 'Calls', value: `${fmt(now.callOI)}${p ? ` (${signed(now.callOI - p.callOI, 0)})` : ''}`, color: CALL },
            { label: 'Puts', value: `${fmt(now.putOI)}${p ? ` (${signed(now.putOI - p.putOI, 0)})` : ''}`, color: PUT },
        ];
    };
    if (oiMode === 'level') {
        strikeBars($('oi-chart'), strikes.map((r) => ({ strike: r.strike, up: r.callOI, down: r.putOI })), { upLabel: 'Calls', downLabel: 'Puts', upColor: CALL, downColor: PUT, lines: levels, tip });
    } else {
        strikeBars(
            $('oi-chart'),
            strikes.map((r) => {
                const p = prev.get(r.strike);
                return { strike: r.strike, up: r.callOI - (p?.callOI ?? 0), down: r.putOI - (p?.putOI ?? 0) };
            }),
            { upLabel: 'Call change', downLabel: 'Put change', upColor: CALL, downColor: PUT, lines: levels, tip, paired: true, signed: true },
        );
    }
}

function renderRisk(v: SymbolView): void {
    const s = v.read.summary;
    const t = v.terms;
    const host = $('risk');
    const rows: Array<[string, string, string?]> = [];
    const notional = s.spot * 100;
    if (t) {
        if (t.marginable && t.marginLong != null) rows.push(['Buy on margin', money((notional * t.marginLong) / 100, 0), `${fmt(t.marginLong)}% of ${money(notional, 0)}`]);
        else rows.push(['Buy', money(notional, 0), 'cash only — not marginable']);
        rows.push(t.shortable && t.marginShort != null ? ['Sell short', money((notional * t.marginShort) / 100, 0), `${fmt(t.marginShort)}% · ${t.easyToBorrow ? 'easy to borrow' : 'hard to borrow'}`] : ['Sell short', 'Not available', 'the broker does not lend these shares']);
        if (t.maintenance != null) rows.push(['Keep the position', `${fmt(t.maintenance)}%`, 'maintenance requirement of position value']);
    } else rows.push(['Margin', '—', 'the broker publishes no terms for this symbol']);
    if (s.iv30 != null) {
        const daily = (s.spot * s.iv30) / Math.sqrt(252);
        rows.push(['Typical day', `±${money(daily)}`, `±${money(daily * 100, 0)} per 100 shares (1σ, from 30-day IV)`]);
    }
    if (s.expectedMove) rows.push([`By ${day(s.expectedMove.expiry)}`, `±${money(s.expectedMove.amount)}`, `±${money(s.expectedMove.amount * 100, 0)} per 100 shares (1σ)`]);
    rows.push(['One option contract', `${money(notional, 0)}`, 'controls 100 shares at today’s price']);
    const list = h('div', 'risk-list');
    for (const [label, value, hint] of rows) {
        const r = h('div', 'risk-row');
        r.append(h('span', 'name', label), h('b', '', value));
        if (hint) r.append(h('span', 'hint', hint));
        list.append(r);
    }
    host.replaceChildren(list);
}

function renderContracts(host: HTMLElement, rows: ContractRow[], unusual: boolean): void {
    if (rows.length === 0) {
        host.replaceChildren(h('div', 'empty', unusual ? 'Nothing unusual traded today.' : 'No open interest reported.'));
        return;
    }
    const trs = rows.map((r) => {
        const tr = h('tr');
        const kind = h('td');
        kind.append(h('span', `right ${r.right === 'C' ? 'call' : 'put'}`, r.right === 'C' ? 'Call' : 'Put'), document.createTextNode(` ${fmt(r.strike, r.strike % 1 ? 1 : 0)}`));
        tr.append(kind, cell(day(r.expiry)));
        if (unusual) tr.append(cell(fmt(r.volume), 'num'), cell(fmt(r.oi), 'num'), cell(`${fmt(r.ratio, 1)}×`, 'num'), cell(`$${compact(r.premium ?? 0)}`, 'num'));
        else tr.append(cell(fmt(r.oi), 'num'), cell(fmt(r.volume), 'num'), cell(money(r.mid), 'num'));
        tr.append(cell(pct(r.iv, 0), 'num'));
        return tr;
    });
    host.replaceChildren(
        unusual
            ? table(['Contract', 'Expiry', ['Volume', true], ['Open int.', true], ['Vol/OI', true], ['Premium', true], ['IV', true]], trs)
            : table(['Contract', 'Expiry', ['Open int.', true], ['Volume', true], ['Mid', true], ['IV', true]], trs),
    );
}

function renderHistory(v: SymbolView): void {
    const hist = v.history;
    $('hist-note').textContent = hist.length < 2 ? 'builds up one trading day at a time' : `${hist.length} trading days`;
    if (hist.length < 2) {
        for (const id of ['hist-pcr', 'hist-iv']) $(id).replaceChildren(h('div', 'empty', 'One more day of reads draws the line.'));
        return;
    }
    const xs = hist.map((d) => Date.parse(`${d.date}T20:00:00Z`));
    xyLines($('hist-pcr'), [{ label: 'Put/call OI', color: SERIES[3]!, points: hist.map((d, i) => [xs[i]!, d.pcrOI] as const) }], {
        xFmt: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        yFmt: (y) => fmt(y, 2),
    });
    xyLines($('hist-iv'), [{ label: 'IV 30d', color: SERIES[0]!, points: hist.map((d, i) => [xs[i]!, d.iv30] as const) }], {
        xFmt: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        yFmt: (y) => pct(y, 0),
    });
}

async function main(): Promise<void> {
    const me = await loadMe();
    mountNav(me);
    startMarketBell();
    for (const b of document.querySelectorAll<HTMLButtonElement>('#oi-mode button')) {
        b.onclick = () => {
            if (b.disabled || !view) return;
            oiMode = b.dataset.mode as 'level' | 'change';
            renderSymbol(view);
        };
    }
    $('search').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('search-input') as HTMLInputElement;
        const sym = input.value.trim().toUpperCase();
        if (/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) {
            input.value = '';
            void showSymbol(sym);
        }
    });
    let resize = 0;
    window.addEventListener('resize', () => {
        cancelAnimationFrame(resize);
        resize = requestAnimationFrame(() => view && renderSymbol(view));
    });
    const rows = await loadWatchlist().catch(() => [] as WatchRow[]);
    const linked = new URLSearchParams(location.search).get('symbol');
    const first = linked && /^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(linked) ? linked.toUpperCase() : (rows.find((r) => r.summary)?.symbol ?? rows[0]?.symbol ?? 'SPY');
    await showSymbol(first);
}

main().catch((err: unknown) => {
    console.error(err);
    document.querySelector('main')?.append(h('p', 'empty', 'Could not load the page. Reload to try again.'));
});
