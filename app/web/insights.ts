import './pages.css';
import { api, loadMe } from './lib/api';
import { mountNav } from './lib/nav';
import { startMarketBell } from './lib/market-bell';
import { symbolGlyph } from './lib/symbol-glyph';
import { barList, donut, fmt, h, heatmap, hideTip, showTip } from './lib/viz';

interface Suggestion {
    symbol: string;
    name: string;
    sector: string;
    industry: string;
    score: number;
    because: string[];
    themes: string[];
    link: 'peer' | 'industry' | 'theme';
}

interface Insights {
    since: number | null;
    totals: { opens: number; minutes: number; symbols: number; activeDays: number; currentStreak: number; longestStreak: number; peakHour: number | null };
    topSymbols: Array<{ symbol: string; name: string; cls: string; sector: string | null; opens: number; minutes: number }>;
    timeframes: Array<{ key: string; label: string; value: number }>;
    indicators: Array<{ key: string; label: string; value: number }>;
    styles: Array<{ key: string; value: number }>;
    classMix: Array<{ key: string; value: number }>;
    sectors: Array<{ key: string; value: number }>;
    themes: Array<{ theme: string; weight: number }>;
    heatmap: number[][];
    last30: Array<{ day: string; opens: number; minutes: number }>;
    badges: Array<{ id: string; title: string; detail: string }>;
    suggestions: Suggestion[];
    because: Array<{ symbol: string; name: string; peers: Array<{ symbol: string; name: string }> }>;
}

const BADGE_ICONS: Record<string, string> = {
    scalper: '⚡',
    daytrader: '☀️',
    swing: '🌊',
    investor: '🏛️',
    crypto: '🪙',
    energy: '🛢️',
    macro: '🌍',
    tech: '🚀',
    nightowl: '🦉',
    earlybird: '🌅',
    explorer: '🧭',
    streak: '🔥',
    tinkerer: '🧪',
    newcomer: '✨',
};

const CLASS_LABELS: Record<string, string> = { stock: 'Stocks', etf: 'ETFs', crypto: 'Crypto', index: 'Indices', forex: 'Forex', futures: 'Futures', power: 'Power' };

const $ = (id: string) => document.getElementById(id)!;

function logo(symbol: string, cls: string | null, name: string | null, small = false): HTMLElement {
    const box = h('span', `logo${small ? ' sm' : ''}`);
    const glyph = symbolGlyph({ ticker: symbol, type: cls, description: name });
    const img = h('img');
    img.alt = '';
    img.src = glyph;
    if (cls === 'stock' || cls === 'etf' || cls === 'crypto' || cls == null) {
        // The generated icon shows until the real logo has loaded; a miss keeps it.
        const remote = new Image();
        remote.onload = () => (img.src = remote.src);
        remote.src = `/api/logo/${encodeURIComponent(symbol)}`;
    }
    box.append(img);
    return box;
}

function kpi(cls: string, label: string, value: string, hint: string, gradient = false): HTMLElement {
    const c = h('div', `card kpi ${cls} fade-in`);
    c.append(h('div', 'label', label), h('div', `value${gradient ? ' gradient' : ''}`, value), h('div', 'hint', hint));
    return c;
}

/** Count up to the final number — the page is meant to be a bit of a show. */
function countUp(el: HTMLElement, to: number, suffix = ''): void {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || to <= 0) {
        el.textContent = `${fmt(to)}${suffix}`;
        return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
        const p = Math.min(1, (t - t0) / 900);
        el.textContent = `${fmt(Math.round(to * (1 - Math.pow(1 - p, 3))))}${suffix}`;
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

interface WatchDoc {
    version: 1;
    groups: Array<{ name: string; symbols: string[]; collapsed?: boolean }>;
}

async function addToWatchlist(symbol: string): Promise<void> {
    let doc: WatchDoc | null;
    try {
        doc = JSON.parse(await api<string>('/api/storage/watchlist')) as WatchDoc;
    } catch {
        doc = null;
    }
    if (!doc || !Array.isArray(doc.groups)) {
        const d = await api<{ groups: Array<{ name: string; symbols: string[] }> }>('/api/watchlist/defaults');
        doc = { version: 1, groups: d.groups };
    }
    let g = doc.groups.find((x) => x.name === 'Suggestions');
    if (!g) {
        g = { name: 'Suggestions', symbols: [] };
        doc.groups.push(g);
    }
    if (!g.symbols.includes(symbol)) g.symbols.push(symbol);
    await api('/api/storage/watchlist', { method: 'PUT', text: JSON.stringify(doc) });
    // The add already succeeded; content blockers often drop analytics requests.
    void api('/api/analytics/events', { method: 'POST', body: { events: [{ k: 'wl', v: symbol, t: Date.now() }] } }).catch(() => {});
}

function suggestionCard(s: Suggestion, i: number): HTMLElement {
    const card = h('div', 'card sugg fade-in');
    card.style.animationDelay = `${i * 50}ms`;
    const top = h('div', 'top');
    const label = h('div');
    label.style.minWidth = '0';
    label.append(h('div', 'sym', s.symbol), h('div', 'nm', s.name));
    top.append(logo(s.symbol, null, s.name), label);
    const meta = h('div', 'meta', `${s.sector} · ${s.industry}`);
    const match = h('div', 'match');
    const track = h('span', 'track');
    const fill = h('span', 'fill');
    fill.style.width = `${Math.max(8, s.score * 100)}%`;
    track.append(fill);
    match.append(h('span', '', 'Match'), track, h('b', '', `${Math.round(s.score * 100)}`));
    const reason = h('div', 'reason');
    const kind = s.link === 'peer' ? 'Peer of' : s.link === 'industry' ? 'Same industry as' : 'Shares themes with';
    reason.append(document.createTextNode(`${kind} `), h('b', '', s.because.join(', ')));
    const chips = h('div', 'chips');
    for (const t of s.themes) chips.append(h('span', 'chip', t));
    const actions = h('div', 'actions');
    const open = h('button', 'btn', 'Open chart');
    open.onclick = () => (location.href = `/?symbol=${encodeURIComponent(s.symbol)}`);
    const add = h('button', 'btn ghost', '+ Watchlist');
    add.onclick = async () => {
        add.disabled = true;
        try {
            await addToWatchlist(s.symbol);
        } catch {
            add.disabled = false;
            add.textContent = 'Retry';
            return;
        }
        const added = h('span', 'added fade-in', 'Added');
        added.setAttribute('role', 'status');
        add.replaceWith(added);
    };
    actions.append(open, add);
    card.append(top, meta, match, reason);
    if (s.themes.length) card.append(chips);
    card.append(actions);
    return card;
}

function render(d: Insights): void {
    const t = d.totals;
    $('badges').replaceChildren(
        ...d.badges.map((b, i) => {
            const el = h('div', 'badge');
            el.style.animationDelay = `${i * 80}ms`;
            el.append(h('b', '', `${BADGE_ICONS[b.id] ?? '★'} ${b.title}`), h('span', '', b.detail));
            return el;
        }),
    );

    const kOpens = kpi('g1', 'Charts opened', '0', d.since ? `since ${new Date(d.since).toLocaleDateString()}` : 'start browsing to fill this in', true);
    const kMin = kpi('g2', 'Minutes on charts', '0', 'while the page was visible');
    const kSym = kpi('g3', 'Symbols explored', '0', 'distinct tickers');
    const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
    const kStreak = kpi('g4', 'Day streak', '0', `longest: ${days(t.longestStreak)} · ${t.activeDays} active ${t.activeDays === 1 ? 'day' : 'days'}`);
    const kPeak = kpi('g5', 'Peak hour', t.peakHour == null ? '—' : `${String(t.peakHour).padStart(2, '0')}:00`, 'your busiest hour of the day');
    $('kpis').replaceChildren(kOpens, kMin, kSym, kStreak, kPeak);
    countUp(kOpens.querySelector('.value')!, t.opens);
    countUp(kMin.querySelector('.value')!, t.minutes);
    countUp(kSym.querySelector('.value')!, t.symbols);
    countUp(kStreak.querySelector('.value')!, t.currentStreak, t.currentStreak > 0 ? ' 🔥' : '');

    const sugg = $('suggestions');
    if (d.suggestions.length === 0) {
        const empty = h('div', 'card empty-hero');
        empty.append(h('b', '', 'Nothing to suggest yet'), h('span', '', 'Open a few charts — suggestions appear as soon as the map knows what you like.'));
        sugg.replaceChildren(empty);
    } else {
        sugg.replaceChildren(...d.suggestions.map(suggestionCard));
    }
    $('because').replaceChildren(
        ...d.because
            .filter((b) => b.peers.length)
            .map((b) => {
                const row = h('div', 'because-row');
                row.append(document.createTextNode('Because you watch '), h('b', '', b.symbol), document.createTextNode(' →'));
                for (const p of b.peers) {
                    const a = h('a', 'chip', p.symbol);
                    a.href = `/?symbol=${encodeURIComponent(p.symbol)}`;
                    a.title = p.name;
                    row.append(a);
                }
                return row;
            }),
    );

    barList(
        $('top-symbols'),
        d.topSymbols.map((s) => ({ label: s.symbol, value: s.opens + s.minutes * 0.5, display: `${s.opens} · ${s.minutes}m`, title: s.name, lead: logo(s.symbol, s.cls, s.name, true) })),
        { fill: 'linear-gradient(90deg, #7b5cff, #2f8bff, #1fd1a5)' },
    );
    const themes = $('themes');
    themes.classList.add('big');
    if (d.themes.length === 0) themes.replaceChildren(h('div', 'empty', 'No themes yet'));
    else
        themes.replaceChildren(
            ...d.themes.map((th) => {
                const c = h('span', 'chip', th.theme);
                c.style.fontSize = `${11 + th.weight * 6}px`;
                c.style.background = `linear-gradient(135deg, rgba(123,92,255,${0.12 + th.weight * 0.4}), rgba(31,209,165,${0.08 + th.weight * 0.3}))`;
                return c;
            }),
        );
    barList(
        $('sectors'),
        d.sectors.map((s) => ({ label: s.key, value: s.value, display: '' })),
        { fill: 'linear-gradient(90deg, #ff4f8b, #ff8a4c, #ffc44d)' },
    );

    donut($('timeframes'), d.timeframes.map((x) => ({ label: x.label, value: x.value })), { centerLabel: 'uses' });
    donut($('classes'), d.classMix.map((x) => ({ label: CLASS_LABELS[x.key] ?? x.key, value: x.value })), { centerLabel: 'interest' });
    barList($('indicators'), d.indicators.map((x) => ({ label: x.label, value: x.value })), { fill: 'linear-gradient(90deg, #1fd1a5, #2f8bff)' });

    $('tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
    heatmap($('heatmap'), d.heatmap);
    renderDaily($('daily'), d.last30);
}

/** 30 daily columns; one series. */
function renderDaily(host: HTMLElement, days: Insights['last30']): void {
    host.replaceChildren();
    const max = Math.max(...days.map((d) => d.opens), 1);
    const box = h('div');
    box.style.cssText = 'display:flex;align-items:flex-end;gap:3px;height:150px;padding-top:6px';
    days.forEach((d, i) => {
        const col = h('div');
        const pct = (d.opens / max) * 100;
        col.style.cssText = `flex:1;height:${Math.max(d.opens ? 4 : 2, pct)}%;border-radius:4px 4px 0 0;background:${d.opens ? 'linear-gradient(180deg,#1fd1a5,#2f8bff 60%,#7b5cff)' : 'rgba(255,255,255,0.06)'};transform-origin:bottom;animation:grow-y .8s ${i * 15}ms cubic-bezier(.2,.8,.2,1) both`;
        col.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), [{ label: 'Charts opened', value: String(d.opens) }, { label: 'Minutes', value: String(d.minutes) }]));
        col.addEventListener('pointerleave', hideTip);
        box.append(col);
    });
    const axis = h('div');
    axis.style.cssText = 'display:flex;justify-content:space-between;color:var(--text-muted);font-size:11px;margin-top:6px';
    axis.append(h('span', '', new Date(`${days[0]!.day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })), h('span', '', 'today'));
    host.append(box, axis);
}

async function main(): Promise<void> {
    const me = await loadMe();
    mountNav(me);
    startMarketBell();
    $('title').textContent = `${me.username}'s trading fingerprint`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
    const load = async () => render(await api<Insights>(`/api/analytics/me?tz=${encodeURIComponent(tz)}`));
    await load();
    $('reset').onclick = async () => {
        if (!confirm('Erase your activity history? Suggestions start over.')) return;
        await api('/api/analytics/me', { method: 'DELETE' });
        await load();
    };
}

main().catch((err: unknown) => console.error(err));
