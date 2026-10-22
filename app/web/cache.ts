import './pages.css';
import { api, loadMe } from './lib/api';
import { mountNav } from './lib/nav';
import { startMarketBell } from './lib/market-bell';
import { PROVIDERS } from './lib/providers';
import { SERIES, barList, donut, fmt, h, timeChart } from './lib/viz';

type Status = 'complete' | 'fresh' | 'stale' | 'missing';

interface Overview {
    now: number;
    startedAt: number;
    isAdmin: boolean;
    storage: { sizeBytes: number; retentionDays: number; maxBarsPerSeries: number; series: number; bars: number; symbols: number; quotes: number; oldestFetch: number | null; newestFetch: number | null };
    byTimeframe: Array<{ tf: string; series: number; bars: number }>;
    counters: Record<'complete' | 'merged' | 'range' | 'fetched' | 'passthrough' | 'replaced' | 'peekHit' | 'peekMiss' | 'quotePeekHit' | 'quotePeekMiss' | 'storeErrors', number>;
    bySource: Array<{ source: string; avoided: number; tailOnly: number; full: number; barsFromCache: number; barsFromUpstream: number }>;
    freshness: Array<{ symbol: string; tf: string; session: string; status: Status; fetchedAt: number | null; bars: number; source: string | null; target: boolean; watchers: number }>;
    targets: { pairs: number; symbols: number };
    quotes: { count: number; newest: number | null; oldest: number | null };
    warmer: {
        state: 'idle' | 'waiting' | 'running';
        reason: string;
        quietForMs: number;
        quietNeededMs: number;
        reserve: number;
        manualQueued: boolean;
        pass: { kind: string; total: number; index: number; done: number; skipped: number; failed: number; calls: number; startedAt: number; current: { symbol: string; tf: string } | null } | null;
        upcoming: Array<{ kind: string; at: number }>;
    } | null;
    runs: Array<{ id: number; kind: string; startedAt: number; endedAt: number | null; total: number; done: number; skipped: number; failed: number; calls: number; status: string }>;
    activity: Array<{ t: number; user: number; background: number }>;
    sessions: { regular: Array<[number, number]>; extended: Array<[number, number]> };
    timings: { summary: Array<{ kind: string; count: number; p50: number | null; p95: number | null }>; hours: Array<{ t: number; cached: number | null; cold: number | null }> };
    events: Array<{ at: number; kind: string; detail: string }>;
    budgets: Array<{ id: string; headroom: number; perMinute: number }>;
}

const REFRESH_MS = 10_000;

const PASS_NAMES: Record<string, string> = {
    close: 'After the close',
    premarket: 'Before the open',
    intraday: 'Midday top-up',
    crypto: 'Crypto',
    manual: 'Requested',
};

const STATUS_META: Record<Status, { label: string; color: string; hint: string }> = {
    complete: { label: 'Complete', color: 'var(--series-3)', hint: 'nothing newer until the next session — opens with no provider call' },
    fresh: { label: 'Fresh', color: 'var(--series-1)', hint: 'fetched in the last 2 hours' },
    stale: { label: 'Older', color: 'var(--series-4)', hint: 'paints at once, then catches up' },
    missing: { label: 'Not cached', color: 'var(--series-other)', hint: 'waits for the provider' },
};

function ago(t: number | null, now: number): string {
    if (!t) return 'never';
    const s = Math.round((now - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

function inFuture(t: number, now: number): string {
    const m = Math.max(0, Math.round((t - now) / 60_000));
    if (m < 60) return `in ${m} min`;
    if (m < 48 * 60) return `in ${Math.floor(m / 60)} h ${m % 60} min`;
    return `in ${Math.round(m / 1440)} days`;
}

function bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${fmt(n / 1024, 1)} KB`;
    if (n < 1024 ** 3) return `${fmt(n / 1024 ** 2, 1)} MB`;
    return `${fmt(n / 1024 ** 3, 2)} GB`;
}

function clock(t: number): string {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Bar duration of a timeframe string, for ordering the freshness columns. */
function tfMinutes(tf: string): number {
    const m = /^(\d*)([DWM])$/i.exec(tf);
    if (m) return (m[1] ? Number(m[1]) : 1) * { D: 1440, W: 10_080, M: 43_200 }[m[2]!.toUpperCase() as 'D' | 'W' | 'M'];
    return Number(tf) || 0;
}

function tfLabel(tf: string): string {
    const n = Number(tf);
    if (!Number.isFinite(n)) return tf;
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
}

/** A row of KPI cards, created on first use and updated by key afterwards. */
function kpiRow(host: HTMLElement): (key: string, cls: string, label: string, value: string, hint: string) => void {
    const cards = new Map<string, { v: HTMLElement; hi: HTMLElement }>();
    return (key, cls, label, value, hint) => {
        let k = cards.get(key);
        if (!k) {
            const c = h('div', `card kpi ${cls} fade-in`);
            k = { v: h('div', 'value'), hi: h('div', 'hint') };
            c.append(h('div', 'label', label), k.v, k.hi);
            host.append(c);
            cards.set(key, k);
        }
        if (k.v.textContent !== value) k.v.textContent = value;
        if (k.hi.textContent !== hint) k.hi.textContent = hint;
    };
}

/** Redraw unless the pointer is reading it — the next refresh catches up. */
function whenIdle(id: string, draw: (host: HTMLElement) => void): void {
    const host = document.getElementById(id)!;
    if (host.matches(':hover')) return;
    draw(host);
}

function facts(rows: Array<[string, string]>): HTMLElement {
    const box = h('div', 'cache-facts');
    for (const [k, v] of rows) box.append(h('span', '', k), h('b', '', v));
    return box;
}

let kpis: ReturnType<typeof kpiRow> | null = null;

/** A labeled progress track (the quiet timer, the pass progress). */
function track(label: string, fraction: number, sub: string, fill?: string): HTMLElement {
    const box = h('div', 'cache-progress');
    const t = h('div', 'track');
    const f = h('div', 'fill');
    f.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    if (fill) f.style.background = fill;
    t.append(f);
    box.append(h('div', 'cache-prog-label', label), t, h('div', 'cache-prog-sub', sub));
    return box;
}

function renderKpis(o: Overview): void {
    kpis ??= kpiRow(document.getElementById('kpis')!);
    const opens = o.timings.summary.filter((s) => s.kind === 'complete' || s.kind === 'cached' || s.kind === 'cold');
    const totalOpens = opens.reduce((a, s) => a + s.count, 0);
    const instant = opens.filter((s) => s.kind !== 'cold').reduce((a, s) => a + s.count, 0);
    const cachedP50 = o.timings.summary.find((s) => s.kind === 'cached')?.p50 ?? o.timings.summary.find((s) => s.kind === 'complete')?.p50 ?? null;
    const coldP50 = o.timings.summary.find((s) => s.kind === 'cold')?.p50 ?? null;
    const c = o.counters;
    const avoided = c.complete + c.range;
    kpis('size', 'g1', 'Cache size', bytes(o.storage.sizeBytes), `${fmt(o.storage.bars)} bars in ${fmt(o.storage.series)} series`);
    kpis('symbols', 'g2', 'Symbols covered', fmt(o.storage.symbols), `${fmt(o.targets.symbols)} watched · ${fmt(o.targets.pairs)} charts to warm`);
    kpis('instant', 'g3', 'Charts painted from cache', totalOpens ? `${fmt((instant / totalOpens) * 100)}%` : '—', totalOpens ? `${fmt(instant)} of ${fmt(totalOpens)} opens in 24 h` : 'no chart opens measured yet');
    kpis('first', 'g4', 'First bar', cachedP50 != null ? `${fmt(cachedP50)} ms` : '—', coldP50 != null ? `median from cache · ${fmt(coldP50)} ms without` : 'median from cache');
    kpis('saved', 'g5', 'Loads without a full fetch', fmt(avoided + c.merged), `${fmt(avoided)} with no provider call · ${fmt(c.merged)} topped up`);
    kpis('quotes', 'g1', 'Prices cached', fmt(o.quotes.count), o.quotes.newest ? `newest ${ago(o.quotes.newest, o.now)}` : 'none yet');
}

function renderWarmer(o: Overview): void {
    const box = document.getElementById('warmer')!;
    const w = o.warmer;
    if (!w) {
        box.replaceChildren(h('h3', '', 'Warmer'), h('div', 'empty', 'The warmer is not running in this process.'));
        return;
    }
    const [cls, label] = w.state === 'running' ? ['good', 'Warming'] : w.state === 'waiting' ? ['warning', 'Waiting'] : ['off', 'Idle'];
    const head = h('div', 'cache-head');
    const title = h('h3', '', 'Warmer');
    title.style.margin = '0';
    const status = h('span', `status ${cls}`, label);
    head.append(title, status);

    const quiet = Math.min(1, w.quietForMs / w.quietNeededMs);
    const quietLabel = quiet >= 1 ? 'Providers are quiet' : w.quietForMs === 0 ? 'Providers are busy' : `Quiet for ${Math.round(w.quietForMs / 1000)} s`;
    const parts: HTMLElement[] = [
        head,
        facts([
            ['Now', w.reason],
            ['Budget left free', `${fmt(w.reserve * 100)}% of each provider's`],
            ...(w.manualQueued ? ([['Queued', 'a requested full pass']] as Array<[string, string]>) : []),
        ]),
        track(quietLabel, quiet, `Warming starts after ${Math.round(w.quietNeededMs / 60_000)} minutes without a user reaching a provider and with no chart open.`, 'var(--series-3)'),
    ];
    parts[1]!.style.marginTop = '12px';
    if (w.pass) {
        const p = w.pass;
        parts.push(
            track(
                `${PASS_NAMES[p.kind] ?? p.kind} pass · ${fmt(p.index)} / ${fmt(p.total)} steps${p.current ? ` · next ${p.current.symbol} ${tfLabel(p.current.tf)}` : ''}`,
                p.total ? p.index / p.total : 0,
                `${fmt(p.done)} done · ${fmt(p.skipped)} skipped · ${fmt(p.failed)} failed · ${fmt(p.calls)} provider calls · started ${ago(p.startedAt, o.now)}`,
            ),
        );
    }
    // Per-provider headroom: what the warmer looks at before every request.
    const budget = h('div');
    budget.style.marginTop = '12px';
    barList(
        budget,
        o.budgets.map((b) => ({ label: PROVIDERS[b.id]?.name ?? b.id, value: Math.round(b.headroom * 100), display: `${fmt(b.headroom * 100)}% free`, title: `${b.perMinute} requests per minute` })),
        { fill: 'var(--series-3)' },
    );
    parts.push(h('div', 'cache-prog-sub', 'Request budget free right now'), budget);
    box.replaceChildren(...parts);
}

function renderUpcoming(o: Overview): void {
    const box = document.getElementById('upcoming')!;
    const list = h('div', 'cache-upcoming');
    for (const u of o.warmer?.upcoming ?? []) {
        const row = h('div', 'row');
        row.append(h('span', 'name', PASS_NAMES[u.kind] ?? u.kind), h('span', 'when', clock(u.at)), h('span', 'in', inFuture(u.at, o.now)));
        list.append(row);
    }
    const parts: HTMLElement[] = [list];
    if (o.runs.length) {
        const table = h('table', 'data');
        const head = h('tr');
        for (const c of ['Pass', 'Started', 'Steps', 'Calls', 'Status']) head.append(h('th', c === 'Steps' || c === 'Calls' ? 'num' : '', c));
        table.append(head);
        for (const r of o.runs.slice(0, 8)) {
            const tr = h('tr');
            tr.append(
                h('td', '', PASS_NAMES[r.kind] ?? r.kind),
                h('td', '', ago(r.startedAt, o.now)),
                h('td', 'num', `${fmt(r.done)}/${fmt(r.total)}${r.skipped ? ` · ${fmt(r.skipped)} skipped` : ''}${r.failed ? ` · ${fmt(r.failed)} failed` : ''}`),
                h('td', 'num', fmt(r.calls)),
                h('td', '', r.status),
            );
            table.append(tr);
        }
        const t = h('div', 'cache-prog-sub', 'Recent passes');
        t.style.marginTop = '14px';
        parts.push(t, table);
    } else {
        parts.push(h('div', 'empty', 'No pass has run yet.'));
    }
    box.replaceChildren(...parts);
}

function renderActivity(o: Overview): void {
    whenIdle('chart-activity', (host) => {
        const bands = [
            ...o.sessions.extended.map(([from, to]) => ({ from, to, fill: 'rgba(250, 178, 25, 0.07)' })),
            ...o.sessions.regular.map(([from, to]) => ({ from, to, fill: 'rgba(31, 209, 165, 0.10)' })),
        ];
        timeChart(
            host,
            o.activity.map((a) => a.t),
            [
                { label: 'Users', color: SERIES[0]!, values: o.activity.map((a) => a.user) },
                { label: 'Warmer', color: SERIES[2]!, values: o.activity.map((a) => a.background) },
            ],
            { mode: 'bars', height: 200, bands },
        );
    });
}

function renderFreshness(o: Overview): void {
    const box = document.getElementById('freshness')!;
    if (box.matches(':hover')) return;
    if (o.freshness.length === 0) {
        box.replaceChildren(h('div', 'empty', 'Nothing cached or watched yet.'));
        return;
    }
    const rank: Record<Status, number> = { complete: 3, fresh: 2, stale: 1, missing: 0 };
    // One cell per symbol × timeframe: the best session wins, every session shows in the tip.
    const cells = new Map<string, { status: Status; tips: string[] }>();
    const symbols = new Map<string, number>();
    const tfs = new Set<string>();
    for (const f of o.freshness) {
        symbols.set(f.symbol, Math.max(symbols.get(f.symbol) ?? 0, f.watchers));
        tfs.add(f.tf);
        const key = `${f.symbol}|${f.tf}`;
        const c = cells.get(key) ?? { status: 'missing' as Status, tips: [] };
        if (rank[f.status] > rank[c.status]) c.status = f.status;
        const sess = f.session === 'all' ? '' : ` ${f.session}`;
        c.tips.push(f.fetchedAt ? `${tfLabel(f.tf)}${sess}: ${STATUS_META[f.status].label.toLowerCase()} · ${fmt(f.bars)} bars · fetched ${ago(f.fetchedAt, o.now)}${f.source ? ` from ${PROVIDERS[f.source]?.name ?? f.source}` : ''}` : `${tfLabel(f.tf)}${sess}: not cached yet`);
        cells.set(key, c);
    }
    const cols = [...tfs].sort((a, b) => tfMinutes(a) - tfMinutes(b));
    const rows = [...symbols.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const legendBox = h('div', 'legend');
    for (const s of Object.keys(STATUS_META) as Status[]) {
        const span = h('span');
        const sw = h('i');
        sw.style.background = STATUS_META[s].color;
        span.append(sw, document.createTextNode(`${STATUS_META[s].label} — ${STATUS_META[s].hint}`));
        legendBox.append(span);
    }
    const grid = h('div', 'cache-fresh');
    grid.style.gridTemplateColumns = `minmax(80px, max-content) repeat(${cols.length}, 44px) max-content`;
    grid.append(h('span', 'hd', 'Symbol'));
    for (const tf of cols) grid.append(h('span', 'hd c', tfLabel(tf)));
    grid.append(h('span', 'hd c', 'Watched by'));
    for (const [sym, watchers] of rows) {
        grid.append(h('span', 'sym', sym));
        for (const tf of cols) {
            const c = cells.get(`${sym}|${tf}`);
            const cell = h('span', `cell${c ? '' : ' none'}`);
            if (c) {
                cell.style.background = STATUS_META[c.status].color;
                cell.title = `${sym}\n${c.tips.join('\n')}`;
            }
            grid.append(cell);
        }
        grid.append(h('span', 'num', watchers ? `${watchers} account${watchers === 1 ? '' : 's'}` : '—'));
    }
    const counts = (Object.keys(STATUS_META) as Status[]).map((s) => `${fmt([...cells.values()].filter((c) => c.status === s).length)} ${STATUS_META[s].label.toLowerCase()}`);
    box.replaceChildren(legendBox, h('div', 'cache-prog-sub', counts.join(' · ')), grid);
}

function renderSpeed(o: Overview): void {
    const count = (k: string) => o.timings.summary.find((s) => s.kind === k)?.count ?? 0;
    whenIdle('donut-opens', (host) => {
        const items = [
            { label: 'Complete from cache', value: count('complete') },
            { label: 'Cache, then caught up', value: count('cached') },
            { label: 'Waited for a provider', value: count('cold') },
        ];
        if (items.every((i) => i.value === 0)) host.replaceChildren(h('div', 'empty', 'No chart opens measured yet.'));
        else donut(host, items, { centerLabel: 'opens' });
    });
    whenIdle('donut-quotes', (host) => {
        const items = [
            { label: 'Cached prices first', value: count('quotes-cached') },
            { label: 'Waited for live prices', value: count('quotes-cold') },
        ];
        if (items.every((i) => i.value === 0)) host.replaceChildren(h('div', 'empty', 'No watchlist loads measured yet.'));
        else donut(host, items, { centerLabel: 'loads' });
    });
    const names: Record<string, string> = { complete: 'Chart, complete from cache', cached: 'Chart, from cache', cold: 'Chart, from a provider', 'quotes-cached': 'Watchlist, from cache', 'quotes-cold': 'Watchlist, live only' };
    const table = h('table', 'data');
    const head = h('tr');
    for (const c of ['First paint', 'Count', 'Median', '95th']) head.append(h('th', c === 'First paint' ? '' : 'num', c));
    table.append(head);
    for (const s of o.timings.summary) {
        if (s.kind === 'memory') continue;
        const tr = h('tr');
        tr.append(h('td', '', names[s.kind] ?? s.kind), h('td', 'num', fmt(s.count)), h('td', 'num', s.p50 != null ? `${fmt(s.p50)} ms` : '—'), h('td', 'num', s.p95 != null ? `${fmt(s.p95)} ms` : '—'));
        table.append(tr);
    }
    document.getElementById('timing-table')!.replaceChildren(table);
    whenIdle('chart-timing', (host) =>
        timeChart(
            host,
            o.timings.hours.map((x) => x.t),
            [
                { label: 'From cache', color: SERIES[2]!, values: o.timings.hours.map((x) => x.cached) },
                { label: 'From a provider', color: SERIES[1]!, values: o.timings.hours.map((x) => x.cold) },
            ],
            { mode: 'line', height: 200, unit: ' ms' },
        ),
    );
}

function renderSavings(o: Overview): void {
    const c = o.counters;
    barList(document.getElementById('outcomes')!, [
        { label: 'Complete — no provider call', value: c.complete, display: fmt(c.complete) },
        { label: 'History from cache — no provider call', value: c.range, display: fmt(c.range) },
        { label: 'Cache + newest bars only', value: c.merged, display: fmt(c.merged) },
        { label: 'Full fetch (nothing usable cached)', value: c.fetched, display: fmt(c.fetched) },
        { label: 'Refetched: provider rewrote history', value: c.replaced, display: fmt(c.replaced) },
        { label: 'Instant paints served', value: c.peekHit, display: `${fmt(c.peekHit)} · ${fmt(c.peekMiss)} misses` },
    ]);
    const box = document.getElementById('by-source')!;
    if (o.bySource.length === 0) {
        box.replaceChildren(h('div', 'empty', 'No chart loads since the server started.'));
        return;
    }
    barList(
        box,
        o.bySource.map((s) => {
            const total = s.barsFromCache + s.barsFromUpstream;
            return {
                label: PROVIDERS[s.source]?.name ?? s.source,
                value: s.barsFromCache,
                display: `${fmt(s.barsFromCache)} bars${total ? ` · ${fmt((s.barsFromCache / total) * 100)}%` : ''}`,
                title: `${fmt(s.avoided)} loads with no call · ${fmt(s.tailOnly)} topped up · ${fmt(s.full)} full fetches · ${fmt(s.barsFromUpstream)} bars fetched`,
            };
        }),
        { fill: 'var(--series-3)' },
    );
}

function renderStorage(o: Overview): void {
    const tfBox = document.getElementById('by-tf')!;
    if (o.byTimeframe.length === 0) tfBox.replaceChildren(h('div', 'empty', 'The cache is empty.'));
    else barList(tfBox, o.byTimeframe.map((t) => ({ label: tfLabel(t.tf), value: t.bars, display: `${fmt(t.bars)} bars · ${fmt(t.series)} series` })), { fill: 'var(--series-1)' });
    const s = o.storage;
    document.getElementById('storage')!.replaceChildren(
        h('h3', '', 'Retention'),
        facts([
            ['On disk', bytes(s.sizeBytes)],
            ['Kept for', `${s.retentionDays} days after last use`],
            ['Newest bars per chart', fmt(s.maxBarsPerSeries)],
            ['Oldest refresh', s.oldestFetch ? ago(s.oldestFetch, o.now) : '—'],
            ['Newest refresh', s.newestFetch ? ago(s.newestFetch, o.now) : '—'],
            ['Watchlist prices', `${fmt(s.quotes)} symbols`],
            ['Store errors', fmt(o.counters.storeErrors)],
        ]),
        h('div', 'cache-prog-sub', 'Everything here is a copy of provider data: clearing it only costs speed until the warmer refills it.'),
    );
}

function renderEvents(o: Overview): void {
    const box = document.getElementById('events')!;
    if (o.events.length === 0) {
        box.replaceChildren(h('div', 'empty', 'Nothing logged yet.'));
        return;
    }
    const table = h('table', 'data');
    const head = h('tr');
    for (const c of ['When', 'What', 'Detail']) head.append(h('th', '', c));
    table.append(head);
    for (const e of o.events.slice(0, 20)) {
        const tr = h('tr');
        tr.append(h('td', '', ago(e.at, o.now)), h('td', '', e.kind), h('td', '', e.detail));
        table.append(tr);
    }
    box.replaceChildren(table);
}

function renderAdmin(o: Overview): void {
    const wrap = document.getElementById('admin')!;
    wrap.hidden = !o.isAdmin;
    const box = document.getElementById('actions')!;
    if (!o.isAdmin || box.childElementCount > 0) return;
    const note = h('div', 'cache-prog-sub');
    const action = (label: string, cls: string, path: string, confirmText: string | null, done: string) => {
        const b = h('button', `btn ${cls}`, label);
        b.onclick = async () => {
            if (confirmText && !confirm(confirmText)) return;
            b.disabled = true;
            try {
                await api(path, { method: 'POST', body: {} });
                note.textContent = done;
                await refresh();
            } catch (err) {
                note.textContent = `Failed: ${(err as Error).message}`;
            } finally {
                b.disabled = false;
            }
        };
        return b;
    };
    const row = h('div', 'cache-head');
    row.style.justifyContent = 'flex-start';
    row.append(
        action('Warm everything when quiet', '', '/api/admin/cache/warm', null, 'A full pass is queued; it starts once the providers are quiet.'),
        action('Purge unused now', 'ghost', '/api/admin/cache/purge', null, 'Unused series and prices were purged.'),
        action('Clear the whole cache', 'danger', '/api/admin/cache/clear', 'Clear every cached bar and price? Charts load from the providers until the warmer refills the cache.', 'The cache was cleared.'),
    );
    box.append(row, note);
}

async function refresh(): Promise<void> {
    const o = await api<Overview>('/api/cache/overview');
    document.getElementById('subtitle')!.textContent = `What the server keeps so charts and prices show at once, and how it stays fresh. Counters since ${new Date(o.startedAt).toLocaleString()} · updates every 10 s.`;
    renderKpis(o);
    renderWarmer(o);
    renderUpcoming(o);
    renderActivity(o);
    renderFreshness(o);
    renderSpeed(o);
    renderSavings(o);
    renderStorage(o);
    renderEvents(o);
    renderAdmin(o);
}

async function main(): Promise<void> {
    const me = await loadMe();
    mountNav(me);
    startMarketBell();
    await refresh();
    setInterval(() => {
        if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, REFRESH_MS);
}

main().catch((err: unknown) => console.error(err));
