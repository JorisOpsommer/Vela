// Who an upstream call is for. Every call runs in one of three contexts that the request
// budget and the cache warmer can see:
// - `user`: someone actively charting (opening a chart, scrolling back through history);
// - `upkeep`: what an open but idle screen does on its own (live chart polls, watchlist
//   refreshes, tail refreshes) — it uses the providers, yet nobody is waiting on it;
// - `background`: the cache warmer, which also may steer clear of a bridge whose spare
//   budget belongs to someone else.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BridgeId } from './types';

export type Caller = 'user' | 'upkeep' | 'background';

interface CallerScope {
    caller: Caller;
    /** Bridges this work must not call (background work only). */
    avoid: ReadonlySet<BridgeId>;
}

const scope = new AsyncLocalStorage<CallerScope>();
const NONE: ReadonlySet<BridgeId> = new Set();

/** Run `fn` as background work: its upstream calls are not user activity. */
export function runInBackground<T>(fn: () => Promise<T>, opts: { avoid?: Iterable<BridgeId> } = {}): Promise<T> {
    return scope.run({ caller: 'background', avoid: new Set(opts.avoid ?? []) }, fn);
}

/** Run `fn` as the upkeep of an open screen: it counts as provider use, not as someone charting. */
export function runAsUpkeep<T>(fn: () => Promise<T>): Promise<T> {
    return scope.run({ caller: 'upkeep', avoid: NONE }, fn);
}

export function caller(): Caller {
    return scope.getStore()?.caller ?? 'user';
}

export function isBackground(): boolean {
    return caller() === 'background';
}

/** Whether the current work must stay off `bridge`. Always false outside background work. */
export function avoids(bridge: BridgeId): boolean {
    return scope.getStore()?.avoid.has(bridge) ?? false;
}

/** Upstream calls per minute, split by who made them — the cache page's activity chart. */
export class ActivityLog {
    private lastUserCallAt = 0;
    private readonly minutes = new Map<number, Record<Caller, number>>();

    constructor(private readonly now: () => number = () => Date.now(), private readonly keepMinutes = 24 * 60) {}

    record(kind: Caller): void {
        const t = this.now();
        if (kind === 'user') this.lastUserCallAt = t;
        const minute = Math.floor(t / 60_000);
        let m = this.minutes.get(minute);
        if (!m) {
            m = { user: 0, upkeep: 0, background: 0 };
            this.minutes.set(minute, m);
            for (const k of this.minutes.keys()) if (k <= minute - this.keepMinutes) this.minutes.delete(k);
        }
        m[kind] += 1;
    }

    /** When someone actively charting last reached a provider (0 = never since start). */
    lastUserCall(): number {
        return this.lastUserCallAt;
    }

    /** The trailing `minutes`, oldest first, zero-filled. */
    series(minutes: number): Array<{ t: number } & Record<Caller, number>> {
        const now = Math.floor(this.now() / 60_000);
        const out: Array<{ t: number } & Record<Caller, number>> = [];
        for (let i = minutes - 1; i >= 0; i--) {
            const m = this.minutes.get(now - i);
            out.push({ t: (now - i) * 60_000, user: m?.user ?? 0, upkeep: m?.upkeep ?? 0, background: m?.background ?? 0 });
        }
        return out;
    }
}

export const activity = new ActivityLog();
