import './pages.css';
import { api, loadMe } from './lib/api';
import { mountNav } from './lib/nav';
import { PROVIDERS } from './lib/providers';
import { SERIES, barList, fmt, gauge, h, sparkline, timeChart, type Sparkline } from './lib/viz';

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

const META = PROVIDERS;

const REFRESH_MS = 5_000;

function ago(t: number | null, now: number): string {
    if (!t) return 'never';
    const s = Math.round((now - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
}

/** Budget use: trailing-minute calls against the tighter of the published limit and our own budget. */
function budgetUse(b: BridgeStats): { fraction: number | null; limit: number | null; source: string } {
    const own = b.budget?.perMinute ?? null;
    const pub = b.published.perMinute;
    const limit = pub != null && own != null ? Math.min(pub, own) : (pub ?? own);
    return { fraction: limit ? b.callsLastMinute / limit : null, limit, source: pub != null && (own == null || pub <= own) ? 'the published limit' : 'our own, stricter budget' };
}

// The page refreshes every few seconds. Everything below is built once and then updated
// in place — text, widths and the gauge arc change; nothing is re-created, so no entrance
// animation replays and a value that moves glides to its new place.

interface Kpi {
    set(value: string, hint: string): void;
}

/** A row of KPI cards, created on first use and updated by key afterwards. */
function kpiRow(host: HTMLElement): (key: string, cls: string, label: string, value: string, hint: string) => void {
    const cards = new Map<string, Kpi>();
    return (key, cls, label, value, hint) => {
        let k = cards.get(key);
        if (!k) {
            const c = h('div', `card kpi ${cls} fade-in`);
            const v = h('div', 'value');
            const hi = h('div', 'hint');
            c.append(h('div', 'label', label), v, hi);
            host.append(c);
            k = {
                set(value, hint) {
                    if (v.textContent !== value) v.textContent = value;
                    if (hi.textContent !== hint) hi.textContent = hint;
                },
            };
            cards.set(key, k);
        }
        k.set(value, hint);
    };
}

class ProviderCard {
    readonly el: HTMLElement;
    private readonly status: HTMLElement;
    private readonly meter = gauge('budget used');
    private readonly facts = new Map<string, { k: HTMLElement; v: HTMLElement }>();
    private readonly factsBox: HTMLElement;
    private readonly spark: Sparkline;
    private readonly footLeft: HTMLElement;
    private readonly footRight: HTMLElement;
    private readonly note: HTMLElement;
    private readonly endpoints: HTMLElement;

    constructor(
        id: string,
        private readonly color: string,
    ) {
        const meta = META[id] ?? { name: id, role: '' };
        this.el = h('div', 'card provider fade-in');
        const head = h('div');
        head.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px';
        const title = h('div');
        const name = h('h3', '', meta.name);
        name.style.margin = '0';
        const dot = h('i');
        dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:8px`;
        name.prepend(dot);
        const role = h('div', '', meta.role);
        role.style.cssText = 'color:var(--text-muted);font-size:12px;margin-top:2px';
        title.append(name, role);
        this.status = h('span', 'status');
        head.append(title, this.status);

        const mid = h('div');
        mid.style.cssText = 'display:flex;align-items:center;gap:14px;margin:14px 0 8px';
        this.factsBox = h('div');
        this.factsBox.style.cssText = 'display:grid;grid-template-columns:auto auto;gap:4px 14px;font-size:12.5px;color:var(--text-secondary);white-space:nowrap';
        mid.append(this.meter.el, this.factsBox);

        this.spark = sparkline(color);
        const foot = h('div');
        foot.style.cssText = 'display:flex;justify-content:space-between;color:var(--text-muted);font-size:11.5px;margin-top:4px';
        this.footLeft = h('span');
        this.footRight = h('span');
        foot.append(this.footLeft, this.footRight);
        this.note = h('div');
        this.note.style.cssText = 'color:var(--text-muted);font-size:11.5px;margin-top:8px';
        this.endpoints = h('div');
        this.endpoints.style.marginTop = '12px';
        this.el.append(head, mid, this.spark.el, foot, this.note, this.endpoints);
    }

    private fact(key: string, value: string | null): void {
        let f = this.facts.get(key);
        if (!f) {
            const k = h('span', '', key);
            k.style.color = 'var(--text-muted)';
            const v = h('b');
            v.style.cssText = 'color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums';
            this.factsBox.append(k, v);
            f = { k, v };
            this.facts.set(key, f);
        }
        f.k.hidden = f.v.hidden = value == null;
        if (value != null && f.v.textContent !== value) f.v.textContent = value;
    }

    update(b: BridgeStats, now: number): void {
        const [cls, label] = !b.configured
            ? ['off', 'Not configured']
            : !b.healthy
              ? ['critical', 'Failing — skipped']
              : b.lastErrorAt && now - b.lastErrorAt < 5 * 60_000
                ? ['warning', 'Recent errors']
                : ['good', 'Healthy'];
        this.status.className = `status ${cls}`;
        this.status.textContent = label;

        const use = budgetUse(b);
        this.meter.set(use.fraction);
        this.fact('Last minute', use.limit ? `${b.callsLastMinute} / ${use.limit}` : String(b.callsLastMinute));
        this.fact('Upstream left', b.upstream ? `${b.upstream.remaining} / ${b.upstream.limit}` : null);
        this.fact('Latency p50', b.latency.p50 != null ? `${fmt(b.latency.p50)} ms` : '—');
        this.fact('Latency p95', b.latency.p95 != null ? `${fmt(b.latency.p95)} ms` : '—');
        this.fact('Cache hits', b.cache.hitRate != null ? `${fmt(b.cache.hitRate * 100)}%` : '—');
        this.fact('Errors', `${b.errors}${b.throttled ? ` (${b.throttled}× 429)` : ''}`);

        this.spark.set(b.series.map((s) => s.calls));
        this.footLeft.textContent = `${fmt(b.calls60m)} calls in 60 min · ${fmt(b.total)} since start`;
        this.footRight.textContent = `last ok ${ago(b.lastOkAt, now)}`;
        this.note.textContent = `${b.published.note}${use.limit ? ` · gauge uses ${use.source}` : ''}${b.budget && b.budget.waiting ? ` · ${b.budget.waiting} queued` : ''}`;

        this.endpoints.hidden = b.endpoints.length === 0;
        if (b.endpoints.length) {
            barList(
                this.endpoints,
                b.endpoints.slice(0, 4).map((e) => ({ label: e.tag, value: e.calls, display: `${fmt(e.calls)} · ${fmt(e.avgMs)} ms`, title: `${e.errors} errors` })),
                { fill: this.color },
            );
        }
    }
}

const cards = new Map<string, ProviderCard>();
let kpis: ReturnType<typeof kpiRow> | null = null;
let liveKpis: ReturnType<typeof kpiRow> | null = null;

/** Redraw a chart unless the pointer is reading it — the next refresh catches up. */
function chartWhenIdle(id: string, draw: (host: HTMLElement) => void): void {
    const host = document.getElementById(id)!;
    if (host.matches(':hover')) return;
    draw(host);
}

async function refresh(): Promise<void> {
    const s = await api<Snapshot>('/api/insights/providers');
    const now = s.now;
    document.getElementById('subtitle')!.textContent = `Speed, reliability and rate-limit headroom of every market-data source. Measured since ${new Date(s.startedAt).toLocaleString()} · live, updates every 5 s.`;

    const configured = s.bridges.filter((b) => b.configured);
    const calls60 = configured.reduce((a, b) => a + b.calls60m, 0);
    const errs60 = configured.reduce((a, b) => a + b.series.reduce((x, m) => x + m.errors, 0), 0);
    const hits = configured.reduce((a, b) => a + b.cache.hits + b.cache.coalesced, 0);
    const lookups = configured.reduce((a, b) => a + b.cache.hits + b.cache.coalesced + b.cache.misses, 0);
    const weighted = configured.filter((b) => b.latency.p50 != null);
    const avgP50 = weighted.length ? weighted.reduce((a, b) => a + b.latency.p50! * b.latency.samples, 0) / Math.max(1, weighted.reduce((a, b) => a + b.latency.samples, 0)) : null;
    const healthy = configured.filter((b) => b.healthy).length;

    kpis ??= kpiRow(document.getElementById('kpis')!);
    kpis('calls', 'g1', 'Upstream calls', fmt(calls60), 'last 60 minutes');
    kpis('latency', 'g2', 'Typical response', avgP50 != null ? `${fmt(avgP50)} ms` : '—', 'median across sources');
    kpis('cache', 'g3', 'Served from cache', lookups ? `${fmt((hits / lookups) * 100)}%` : '—', `${fmt(hits)} of ${fmt(lookups)} lookups`);
    kpis('errors', 'g4', 'Error rate', calls60 ? `${fmt((errs60 / calls60) * 100, 1)}%` : '—', `${errs60} failed calls in 60 min`);
    kpis('healthy', 'g5', 'Sources healthy', `${healthy} / ${configured.length}`, 'failing sources are skipped for 60 s');

    const grid = document.getElementById('providers')!;
    s.bridges.forEach((b, i) => {
        let card = cards.get(b.id);
        if (!card) {
            card = new ProviderCard(b.id, SERIES[i]!);
            cards.set(b.id, card);
            grid.append(card.el);
        }
        card.update(b, now);
    });

    const xs = s.bridges[0]?.series.map((p) => p.t) ?? [];
    chartWhenIdle('chart-calls', (host) =>
        timeChart(
            host,
            xs,
            s.bridges.map((b, i) => ({ label: META[b.id]?.name ?? b.id, color: SERIES[i]!, values: b.series.map((p) => p.calls) })),
            { mode: 'bars', height: 220 },
        ),
    );
    chartWhenIdle('chart-latency', (host) =>
        timeChart(
            host,
            xs,
            s.bridges.map((b, i) => ({ label: META[b.id]?.name ?? b.id, color: SERIES[i]!, values: b.series.map((p) => p.p95) })),
            { mode: 'line', height: 220, unit: ' ms' },
        ),
    );

    const ts = s.live.tradeStream;
    liveKpis ??= kpiRow(document.getElementById('live')!);
    liveKpis('topics', 'g1', 'Open chart streams', fmt(s.live.topics), `${fmt(s.live.listeners)} browser subscriptions share them`);
    liveKpis('stream', 'g3', 'Trade stream', ts ? (ts.connected ? 'Connected' : 'Reconnecting') : 'Off', ts ? `${ts.streams} / 50 symbols streamed` : 'Finnhub key not set');
    liveKpis('trades', 'g2', 'Trades received', ts ? fmt(ts.trades) : '—', ts?.lastTradeAt ? `last ${ago(ts.lastTradeAt, now)}` : 'none yet');

    const errBox = document.getElementById('errors')!;
    if (s.errors.length === 0) {
        if (!errBox.querySelector('.empty')) errBox.replaceChildren(h('div', 'empty', 'No upstream errors since start. 🎉'));
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
