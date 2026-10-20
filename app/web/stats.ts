import './pages.css';
import { api, loadMe } from './lib/api';
import { mountNav } from './lib/nav';
import { SERIES, barList, fmt, gauge, h, sparkline, timeChart } from './lib/viz';

interface BridgeStats {
    id: string;
    configured: boolean;
    healthy: boolean;
    total: number;
    errors: number;
    throttled: number;
    callsLastMinute: number;
    calls5m: number;
    calls60m: number;
    latency: { p50: number | null; p95: number | null; max: number | null; samples: number };
    upstream: { remaining: number; limit: number; at: number } | null;
    lastOkAt: number | null;
    lastErrorAt: number | null;
    cache: { hits: number; misses: number; coalesced: number; hitRate: number | null };
    budget: { perMinute: number; available: number; waiting: number; waits: number; rejected: number } | null;
    endpoints: Array<{ tag: string; calls: number; errors: number; avgMs: number }>;
    series: Array<{ t: number; calls: number; errors: number; throttled: number; p50: number | null; p95: number | null }>;
    published: { perMinute: number | null; note: string };
}

interface Snapshot {
    startedAt: number;
    now: number;
    bridges: BridgeStats[];
    errors: Array<{ at: number; bridge: string; tag: string; status: number; message: string }>;
    live: { topics: number; listeners: number; tradeStream: { connected: boolean; streams: number; trades: number; lastTradeAt: number | null } | null };
}

const META: Record<string, { name: string; role: string }> = {
    alpaca: { name: 'Alpaca', role: 'US stocks & ETFs · calendar · search' },
    finnhub: { name: 'Finnhub', role: 'Live trades · logos · fallback quotes' },
    yahoo: { name: 'Yahoo Finance', role: 'Indices · futures · FX' },
    energycharts: { name: 'Energy-Charts', role: 'Belgian day-ahead power' },
    coinbase: { name: 'Coinbase', role: 'Crypto candles & stream' },
};

const REFRESH_MS = 5_000;
/** Entrance animation on the first paint only — refreshes swap content in place. */
let first = true;

function ago(t: number | null, now: number): string {
    if (!t) return 'never';
    const s = Math.round((now - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

function kpi(cls: string, label: string, value: string, hint: string): HTMLElement {
    const c = h('div', `card kpi ${cls}`);
    c.append(h('div', 'label', label), h('div', 'value', value), h('div', 'hint', hint));
    return c;
}

/** Budget use: trailing-minute calls against the tighter of the published limit and our own budget. */
function budgetUse(b: BridgeStats): { fraction: number | null; limit: number | null; source: string } {
    const own = b.budget?.perMinute ?? null;
    const pub = b.published.perMinute;
    const limit = pub != null && own != null ? Math.min(pub, own) : (pub ?? own);
    return { fraction: limit ? b.callsLastMinute / limit : null, limit, source: pub != null && (own == null || pub <= own) ? 'the published limit' : 'our own, stricter budget' };
}

function providerCard(b: BridgeStats, color: string, now: number, animate: boolean): HTMLElement {
    const meta = META[b.id] ?? { name: b.id, role: '' };
    const card = h('div', `card provider${animate ? ' fade-in' : ''}`);
    const head = h('div');
    head.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px';
    const title = h('div');
    const name = h('h3', '', meta.name);
    name.style.margin = '0';
    const dot = h('i');
    dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:8px`;
    name.prepend(dot);
    title.append(name, h('div', 'kpi-hint', meta.role));
    (title.lastChild as HTMLElement).style.cssText = 'color:var(--text-muted);font-size:12px;margin-top:2px';
    const st = !b.configured ? ['off', 'Not configured'] : !b.healthy ? ['critical', 'Failing — skipped'] : b.lastErrorAt && now - b.lastErrorAt < 5 * 60_000 ? ['warning', 'Recent errors'] : ['good', 'Healthy'];
    head.append(title, h('span', `status ${st[0]}`, st[1]));
    card.append(head);

    const use = budgetUse(b);
    const mid = h('div');
    mid.style.cssText = 'display:flex;align-items:center;gap:14px;margin:14px 0 8px';
    mid.append(gauge(use.fraction, 'budget used'));
    const facts = h('div');
    facts.style.cssText = 'display:grid;grid-template-columns:auto auto;gap:4px 14px;font-size:12.5px;color:var(--text-secondary);white-space:nowrap';
    const fact = (k: string, v: string) => {
        const kk = h('span', '', k);
        kk.style.color = 'var(--text-muted)';
        const vv = h('b', '', v);
        vv.style.cssText = 'color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums';
        facts.append(kk, vv);
    };
    fact('Last minute', use.limit ? `${b.callsLastMinute} / ${use.limit}` : String(b.callsLastMinute));
    if (b.upstream) fact('Upstream left', `${b.upstream.remaining} / ${b.upstream.limit}`);
    fact('Latency p50', b.latency.p50 != null ? `${fmt(b.latency.p50)} ms` : '—');
    fact('Latency p95', b.latency.p95 != null ? `${fmt(b.latency.p95)} ms` : '—');
    fact('Cache hits', b.cache.hitRate != null ? `${fmt(b.cache.hitRate * 100)}%` : '—');
    fact('Errors', `${b.errors}${b.throttled ? ` (${b.throttled}× 429)` : ''}`);
    mid.append(facts);
    card.append(mid);

    const spark = sparkline(b.series.map((s) => s.calls), color);
    card.append(spark);
    const foot = h('div');
    foot.style.cssText = 'display:flex;justify-content:space-between;color:var(--text-muted);font-size:11.5px;margin-top:4px';
    foot.append(h('span', '', `${fmt(b.calls60m)} calls in 60 min · ${fmt(b.total)} since start`), h('span', '', `last ok ${ago(b.lastOkAt, now)}`));
    card.append(foot);

    const note = h('div', '', `${b.published.note}${use.limit ? ` · gauge uses ${use.source}` : ''}${b.budget && b.budget.waiting ? ` · ${b.budget.waiting} queued` : ''}`);
    note.style.cssText = 'color:var(--text-muted);font-size:11.5px;margin-top:8px';
    card.append(note);

    if (b.endpoints.length) {
        const ep = h('div');
        ep.style.marginTop = '12px';
        barList(
            ep,
            b.endpoints.slice(0, 4).map((e) => ({ label: e.tag, value: e.calls, display: `${fmt(e.calls)} · ${fmt(e.avgMs)} ms`, title: `${e.errors} errors` })),
            { fill: color },
        );
        card.append(ep);
    }
    return card;
}

async function refresh(): Promise<void> {
    const s = await api<Snapshot>('/api/insights/providers');
    const now = s.now;
    document.getElementById('subtitle')!.textContent = `Speed, reliability and rate-limit headroom of every market-data source. Measured since ${new Date(s.startedAt).toLocaleString()} · refreshes every 5 s.`;

    const configured = s.bridges.filter((b) => b.configured);
    const calls60 = configured.reduce((a, b) => a + b.calls60m, 0);
    const errs60 = configured.reduce((a, b) => a + b.series.reduce((x, m) => x + m.errors, 0), 0);
    const hits = configured.reduce((a, b) => a + b.cache.hits + b.cache.coalesced, 0);
    const lookups = configured.reduce((a, b) => a + b.cache.hits + b.cache.coalesced + b.cache.misses, 0);
    const weighted = configured.filter((b) => b.latency.p50 != null);
    const avgP50 = weighted.length ? weighted.reduce((a, b) => a + b.latency.p50! * b.latency.samples, 0) / Math.max(1, weighted.reduce((a, b) => a + b.latency.samples, 0)) : null;
    const healthy = configured.filter((b) => b.healthy).length;

    document.getElementById('kpis')!.replaceChildren(
        kpi('g1', 'Upstream calls', fmt(calls60), 'last 60 minutes'),
        kpi('g2', 'Typical response', avgP50 != null ? `${fmt(avgP50)} ms` : '—', 'median across sources'),
        kpi('g3', 'Served from cache', lookups ? `${fmt((hits / lookups) * 100)}%` : '—', `${fmt(hits)} of ${fmt(lookups)} lookups`),
        kpi('g4', 'Error rate', calls60 ? `${fmt((errs60 / calls60) * 100, 1)}%` : '—', `${errs60} failed calls in 60 min`),
        kpi('g5', 'Sources healthy', `${healthy} / ${configured.length}`, 'failing sources are skipped for 60 s'),
    );

    const grid = document.getElementById('providers')!;
    grid.replaceChildren(...s.bridges.map((b, i) => providerCard(b, SERIES[i]!, now, first)));
    first = false;

    const xs = s.bridges[0]?.series.map((p) => p.t) ?? [];
    timeChart(
        document.getElementById('chart-calls')!,
        xs,
        s.bridges.map((b, i) => ({ label: META[b.id]?.name ?? b.id, color: SERIES[i]!, values: b.series.map((p) => p.calls) })),
        { mode: 'bars', height: 220 },
    );
    timeChart(
        document.getElementById('chart-latency')!,
        xs,
        s.bridges.map((b, i) => ({ label: META[b.id]?.name ?? b.id, color: SERIES[i]!, values: b.series.map((p) => p.p95) })),
        { mode: 'line', height: 220, unit: ' ms' },
    );

    const ts = s.live.tradeStream;
    document.getElementById('live')!.replaceChildren(
        kpi('g1', 'Open chart streams', fmt(s.live.topics), `${fmt(s.live.listeners)} browser subscriptions share them`),
        kpi('g3', 'Trade stream', ts ? (ts.connected ? 'Connected' : 'Reconnecting') : 'Off', ts ? `${ts.streams} / 50 symbols streamed` : 'Finnhub key not set'),
        kpi('g2', 'Trades received', ts ? fmt(ts.trades) : '—', ts?.lastTradeAt ? `last ${ago(ts.lastTradeAt, now)}` : 'none yet'),
    );

    const errBox = document.getElementById('errors')!;
    if (s.errors.length === 0) {
        errBox.replaceChildren(h('div', 'empty', 'No upstream errors since start. 🎉'));
    } else {
        const table = h('table', 'data');
        const head = h('tr');
        for (const c of ['When', 'Source', 'Endpoint', 'Status', 'Message']) head.append(h('th', '', c));
        table.append(head);
        for (const e of s.errors.slice(0, 15)) {
            const tr = h('tr');
            tr.append(h('td', '', ago(e.at, now)), h('td', '', META[e.bridge]?.name ?? e.bridge), h('td', '', e.tag), h('td', 'num', e.status ? String(e.status) : 'network'), h('td', '', e.message));
            table.append(tr);
        }
        errBox.replaceChildren(table);
    }
}

async function main(): Promise<void> {
    const me = await loadMe();
    mountNav(me);
    await refresh();
    setInterval(() => {
        if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, REFRESH_MS);
}

main().catch((err: unknown) => console.error(err));
