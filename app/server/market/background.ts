// Background work (the cache warmer) runs inside a context that every upstream call can
// see: its calls are counted apart from the users', it can steer clear of a bridge whose
// spare budget belongs to someone else, and the warmer itself watches the users' calls to
// know when the providers are quiet.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BridgeId } from './types';

interface BackgroundScope {
    /** Bridges this work must not call. */
    avoid: ReadonlySet<BridgeId>;
}

const scope = new AsyncLocalStorage<BackgroundScope>();

/** Run `fn` as background work: its upstream calls are not user activity. */
export function runInBackground<T>(fn: () => Promise<T>, opts: { avoid?: Iterable<BridgeId> } = {}): Promise<T> {
    return scope.run({ avoid: new Set(opts.avoid ?? []) }, fn);
}

export function isBackground(): boolean {
    return scope.getStore() !== undefined;
}

/** Whether the current work must stay off `bridge`. Always false for user requests. */
export function avoids(bridge: BridgeId): boolean {
    return scope.getStore()?.avoid.has(bridge) ?? false;
}

/** Upstream calls per minute, split by who made them — the cache page's activity chart. */
export class ActivityLog {
    private lastUserCallAt = 0;
    private readonly minutes = new Map<number, { user: number; background: number }>();

    constructor(private readonly now: () => number = () => Date.now(), private readonly keepMinutes = 24 * 60) {}

    record(background: boolean): void {
        const t = this.now();
        if (!background) this.lastUserCallAt = t;
        const minute = Math.floor(t / 60_000);
        let m = this.minutes.get(minute);
        if (!m) {
            m = { user: 0, background: 0 };
            this.minutes.set(minute, m);
            for (const k of this.minutes.keys()) if (k <= minute - this.keepMinutes) this.minutes.delete(k);
        }
        if (background) m.background += 1;
        else m.user += 1;
    }

    /** When a user request last reached a provider (0 = never since start). */
    lastUserCall(): number {
        return this.lastUserCallAt;
    }

    /** The trailing `minutes`, oldest first, zero-filled. */
    series(minutes: number): Array<{ t: number; user: number; background: number }> {
        const now = Math.floor(this.now() / 60_000);
        const out: Array<{ t: number; user: number; background: number }> = [];
        for (let i = minutes - 1; i >= 0; i--) {
            const m = this.minutes.get(now - i);
            out.push({ t: (now - i) * 60_000, user: m?.user ?? 0, background: m?.background ?? 0 });
        }
        return out;
    }
}

export const activity = new ActivityLog();
