// The market bell: a toast on every signed-in page the moment the US stock market opens or
// closes. Edges come from the exchange calendar (holidays and early closes already applied
// by the server) and are found by checking what was crossed since the previous tick, so a
// laptop waking from sleep or a throttled background tab still catches the latest one. A
// tab that is hidden holds the toast until the user comes back, unless it has gone stale.
import { api } from './api';
import { toast } from './toast';

type Window = readonly [number, number];

export interface MarketEdge {
    kind: 'open' | 'close';
    /** Epoch ms of the open or close. */
    at: number;
}

/** The newest open or close in `(from, to]`, or null when none was crossed. */
export function lastEdgeBetween(from: number, to: number, windows: ReadonlyArray<Window>): MarketEdge | null {
    let best: MarketEdge | null = null;
    for (const [open, close] of windows) {
        if (open > from && open <= to && (!best || open > best.at)) best = { kind: 'open', at: open };
        if (close > from && close <= to && (!best || close > best.at)) best = { kind: 'close', at: close };
    }
    return best;
}

/** The symbol whose calendar stands for "the stock market". */
const MARKET_SYMBOL = 'SPY';
const TICK_MS = 15_000;
/** A bell older than this (the tab was hidden, the laptop asleep) is news no longer. */
const STALE_MS = 30 * 60_000;
const REFETCH_MS = 6 * 3_600_000;
const RETRY_MS = 60_000;
const BACK_MS = 86_400_000;
const AHEAD_MS = 8 * 86_400_000;

export interface MarketBellDeps {
    now(): number;
    windows(from: number, to: number): Promise<ReadonlyArray<Window> | null>;
    visible(): boolean;
    /** First claim wins, so two open windows of the app ring once between them. */
    claim(edge: MarketEdge): boolean;
    ring(edge: MarketEdge): void;
}

export class MarketBell {
    private windows: ReadonlyArray<Window> = [];
    private nextFetch = -Infinity;
    private last: number;
    private pending: MarketEdge | null = null;
    private fetching: Promise<void> | null = null;

    constructor(private readonly deps: MarketBellDeps) {
        this.last = deps.now();
    }

    async tick(): Promise<void> {
        const now = this.deps.now();
        if (now >= this.nextFetch) await (this.fetching ??= this.refetch(now).finally(() => (this.fetching = null)));
        if (now > this.last) {
            const edge = lastEdgeBetween(this.last, now, this.windows);
            if (edge) this.pending = edge;
        }
        this.last = now;
        const edge = this.pending;
        if (!edge || !this.deps.visible()) return;
        this.pending = null;
        if (now - edge.at <= STALE_MS && this.deps.claim(edge)) this.deps.ring(edge);
    }

    private async refetch(now: number): Promise<void> {
        const got = await this.deps.windows(now - BACK_MS, now + AHEAD_MS).catch(() => null);
        if (got) this.windows = got;
        this.nextFetch = now + (got ? REFETCH_MS : RETRY_MS);
    }
}

interface BellLine {
    icon: string;
    title: string;
    body: string;
}

export const OPEN_LINES: readonly BellLine[] = [
    { icon: '🔔', title: 'Ding ding ding! The market is open', body: 'Wall Street just rolled out of bed. May your candles be green and your stops stay untouched 🚀' },
    { icon: '🚀', title: 'Opening bell!', body: 'Buckle up: the bulls and the bears are back on the field 🐂🐻' },
    { icon: '📈', title: 'We are live, people', body: 'The market just opened. Coffee in one hand, chart in the other ☕✨' },
    { icon: '🎺', title: 'Rise and trade!', body: 'The stock market is open. Buy low, sell high, and do not let the first five minutes fool you 😎' },
];

export const CLOSE_LINES: readonly BellLine[] = [
    { icon: '🌙', title: "That's a wrap!", body: 'The market just closed. The candles can rest now, and so can you 😴' },
    { icon: '🛎️', title: 'Closing bell', body: 'Trading is done for the day. Time to go touch some grass 🌱' },
    { icon: '🍿', title: 'Market closed', body: 'Regular hours are over. After-hours is the after-party: enter at your own risk 🎉' },
    { icon: '🦉', title: 'Lights out on Wall Street', body: 'The market just closed. The bulls and the bears are going home to sleep it off 💤' },
];

function ring(edge: MarketEdge): void {
    const lines = edge.kind === 'open' ? OPEN_LINES : CLOSE_LINES;
    const line = lines[Math.floor(Math.random() * lines.length)]!;
    toast({
        key: 'market-bell',
        tone: edge.kind === 'open' ? 'market-open' : 'market-close',
        icon: line.icon,
        title: line.title,
        body: line.body,
        link: location.pathname === '/' ? undefined : { href: '/', label: 'Open charts' },
        timeoutMs: 12_000,
    });
}

function claim(edge: MarketEdge): boolean {
    try {
        const key = `market-bell:${edge.kind}:${edge.at}`;
        if (localStorage.getItem(key)) return false;
        localStorage.setItem(key, '1');
        // Keep only the newest claim around.
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith('market-bell:') && k !== key) localStorage.removeItem(k);
        }
    } catch {
        // Storage blocked: every tab rings on its own.
    }
    return true;
}

/** Start ringing on this page; returns a stop function. */
export function startMarketBell(): () => void {
    const bell = new MarketBell({
        now: () => Date.now(),
        windows: async (from, to) => (await api<{ windows: Array<[number, number]> | null }>(`/api/calendar?symbol=${MARKET_SYMBOL}&from=${Math.floor(from)}&to=${Math.floor(to)}&session=regular`)).windows,
        visible: () => document.visibilityState === 'visible',
        claim,
        ring,
    });
    const tick = () => void bell.tick();
    tick();
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', tick);
    };
}
