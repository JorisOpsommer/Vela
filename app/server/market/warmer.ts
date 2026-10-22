// The cache warmer: prefetches every account's charts and watchlist prices into the on-disk
// cache, so the next visit paints from it. It runs only while nobody is charting — no user
// action reached a provider for a few minutes; screens left open at idle (live charts,
// watchlist refreshes) do not count — and never takes more than half of any provider (see
// BACKGROUND_SHARE). The moment someone starts charting its next request gives way, mid-step
// included. Passes follow the US session: a full one after the close, a quote refresh before
// the open, a few cheap top-ups during the day, and crypto around the clock.
import type { Db } from '../db';
import type { BridgeId } from './types';
import type { CachedMarket } from './cached-market';
import type { LiveHub } from './live';
import { activity, runInBackground } from './background';
import { BACKGROUND_SHARE, BackgroundYield, setBackgroundGate } from './limits';
import { collectTargets, type WarmTarget } from './warm-targets';
import { localDate, zonedWallTime } from './timeframes';

export type PassKind = 'close' | 'premarket' | 'intraday' | 'crypto' | 'manual';

export interface WarmerOptions {
    /** How long the providers must have gone without a call from someone charting. */
    quietMs?: number;
    tickMs?: number;
    /** Pause between two warm requests. */
    stepGapMs?: number;
}

interface Step {
    kind: 'bars' | 'quotes';
    target?: WarmTarget;
    symbols?: string[];
}

interface ActivePass {
    runId: number;
    kind: PassKind;
    slot: number;
    steps: Step[];
    index: number;
    done: number;
    skipped: number;
    failed: number;
    calls: number;
    startedAt: number;
}

const NY = 'America/New_York';
const QUOTE_BATCH = 50;
const PURGE_EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
/** Slots (minutes after New York midnight) of the passes tied to the US session. */
const CLOSE_AFTER_MS = 30 * 60_000;
const PREMARKET_AT = 8 * 60;
const INTRADAY_AT = [10 * 60 + 30, 12 * 60 + 30, 14 * 60 + 30];
const CRYPTO_EVERY_MS = 4 * 3_600_000;

export class CacheWarmer {
    state: 'idle' | 'waiting' | 'running' = 'idle';
    /** Why the warmer is not running, in words for the cache page. */
    reason = 'starting';
    private pass: ActivePass | null = null;
    private manual = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private busy = false;
    private lastPurge = 0;
    private readonly bootAt: number;
    private readonly quietMs: number;
    private readonly stepGapMs: number;
    private readonly tickMs: number;

    constructor(
        private readonly cached: CachedMarket,
        private readonly db: Db,
        private readonly hub: LiveHub,
        opts: WarmerOptions = {},
        private readonly now: () => number = Date.now,
    ) {
        this.quietMs = opts.quietMs ?? 3 * 60_000;
        this.stepGapMs = opts.stepGapMs ?? 250;
        this.tickMs = opts.tickMs ?? 30_000;
        this.bootAt = now();
        this.cached.store.abandonRunning();
        // Every background request checks this first, so a step stops at its next request.
        setBackgroundGate(() => this.quiet());
    }

    start(): void {
        this.timer ??= setInterval(() => void this.tick(), this.tickMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        setBackgroundGate(null);
    }

    /** Ask for a full pass at the next quiet moment. */
    warmNow(): void {
        this.manual = true;
        void this.tick();
    }

    /** How long no one charting has reached a provider. Idle open screens do not count. */
    quietFor(): number {
        return Math.max(0, this.now() - Math.max(activity.lastUserCall(), this.bootAt));
    }

    private quiet(): boolean {
        return this.quietFor() >= this.quietMs;
    }

    /** One scheduling round: purge when due, then start or continue a pass while quiet. */
    async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        // Even the calendar lookups that schedule a pass are the warmer's own calls.
        await runInBackground(() => this.round()).finally(() => {
            this.busy = false;
        });
    }

    private async round(): Promise<void> {
        if (this.now() - this.lastPurge >= PURGE_EVERY_MS) {
            this.lastPurge = this.now();
            try {
                this.cached.store.purge();
            } catch {
                // A failed purge retries tomorrow; the cache keeps serving.
            }
        }
        if (!this.pass) {
            const due = await this.nextDue();
            if (!due) {
                this.state = 'idle';
                this.reason = 'nothing due';
                return;
            }
            if (!this.quiet()) return this.wait();
            this.begin(due.kind, due.slot);
        }
        await this.run();
    }

    private wait(): void {
        this.state = 'waiting';
        this.reason = this.waitReason();
        if (this.pass) this.cached.store.updateRun(this.pass.runId, { ...this.progress(), status: 'paused' });
    }

    private waitReason(): string {
        return this.quiet() ? 'quiet — starts on the next round' : 'someone is charting';
    }

    private progress() {
        const p = this.pass!;
        return { done: p.done, skipped: p.skipped, failed: p.failed, calls: p.calls };
    }

    private begin(kind: PassKind, slot: number): void {
        const plan = collectTargets(this.db, this.cached.market.catalog, this.now());
        const steps: Step[] = [];
        const isCrypto = (t: WarmTarget) => this.cached.market.resolve(t.symbol)?.class === 'crypto';
        if (kind !== 'premarket') {
            for (const t of plan.targets) if (kind !== 'crypto' || isCrypto(t)) steps.push({ kind: 'bars', target: t });
        }
        if (kind === 'close' || kind === 'premarket' || kind === 'manual') {
            const symbols = [...plan.watched.keys()];
            for (let i = 0; i < symbols.length; i += QUOTE_BATCH) steps.push({ kind: 'quotes', symbols: symbols.slice(i, i + QUOTE_BATCH) });
        }
        const runId = this.cached.store.startRun(kind, slot, steps.length);
        this.pass = { runId, kind, slot, steps, index: 0, done: 0, skipped: 0, failed: 0, calls: 0, startedAt: this.now() };
        if (kind === 'manual') this.manual = false;
    }

    private async run(): Promise<void> {
        const p = this.pass!;
        this.state = 'running';
        this.reason = `${p.kind} pass`;
        this.cached.store.updateRun(p.runId, { ...this.progress(), status: 'running' });
        // Outside regular hours Yahoo's spare budget feeds the real-time pre/post prices.
        const avoid: BridgeId[] = (await this.cached.market.usRegularOpen(this.now()).catch(() => false)) ? [] : ['yahoo'];
        while (p.index < p.steps.length) {
            if (!this.quiet()) return this.wait();
            const step = p.steps[p.index]!;
            const before = activity.series(1)[0]!.background;
            const beforeMinute = Math.floor(this.now() / 60_000);
            try {
                await runInBackground(async () => {
                    if (step.kind === 'quotes') await this.cached.quotes(step.symbols!);
                    else await this.cached.bars(step.target!.symbol, step.target!.tf, { limit: step.target!.limit, session: step.target!.session === 'extended' ? 'extended' : 'regular' });
                }, { avoid });
                p.done += 1;
            } catch (err) {
                // Giving way is not a failure: the step stays next in line.
                if (err instanceof BackgroundYield) {
                    if (err.reason === 'user') return this.wait();
                    this.state = 'waiting';
                    this.reason = 'holding under half of a provider';
                    return;
                }
                if ((err as { status?: number }).status === 409 || (err as { status?: number }).status === 400) p.skipped += 1;
                else p.failed += 1;
            }
            // Calls this step made (a minute boundary in between only undercounts).
            if (Math.floor(this.now() / 60_000) === beforeMinute) p.calls += activity.series(1)[0]!.background - before;
            p.index += 1;
            if (p.index % 5 === 0) this.cached.store.updateRun(p.runId, this.progress());
            if (this.stepGapMs > 0) await new Promise((r) => setTimeout(r, this.stepGapMs));
        }
        this.cached.store.updateRun(p.runId, { ...this.progress(), status: 'done', ended: true });
        this.pass = null;
        this.state = 'idle';
        this.reason = 'pass finished';
    }

    /** The oldest pass whose slot has come and that has not completed for that slot. */
    private async nextDue(): Promise<{ kind: PassKind; slot: number } | null> {
        if (this.manual) return { kind: 'manual', slot: this.now() };
        const slots = await this.latestSlots(this.now());
        const due = slots.filter((s) => {
            const last = this.cached.store.lastRun(s.kind);
            return !last || last.slot < s.slot || (last.slot === s.slot && last.status !== 'done');
        });
        due.sort((a, b) => a.slot - b.slot);
        return due[0] ?? null;
    }

    /** The most recent slot of each pass kind at or before `now`. */
    async latestSlots(now: number): Promise<Array<{ kind: PassKind; slot: number }>> {
        const out: Array<{ kind: PassKind; slot: number }> = [];
        const days = await this.tradingDays(now - 5 * DAY_MS, now + DAY_MS);
        const pick = (kind: PassKind, times: number[]) => {
            const past = times.filter((t) => t <= now);
            if (past.length > 0) out.push({ kind, slot: Math.max(...past) });
        };
        pick('close', days.map((d) => d.close + CLOSE_AFTER_MS));
        pick('premarket', days.map((d) => d.midnight + PREMARKET_AT * 60_000));
        pick('intraday', days.flatMap((d) => INTRADAY_AT.map((m) => d.midnight + m * 60_000).filter((t) => t < d.close)));
        out.push({ kind: 'crypto', slot: Math.floor(now / CRYPTO_EVERY_MS) * CRYPTO_EVERY_MS });
        return out;
    }

    /** Upcoming slots, for the cache page's countdowns. */
    async upcoming(now: number): Promise<Array<{ kind: PassKind; at: number }>> {
        const days = await this.tradingDays(now - DAY_MS, now + 6 * DAY_MS);
        const next = (times: number[]) => times.filter((t) => t > now).sort((a, b) => a - b)[0];
        const rows: Array<{ kind: PassKind; at: number | undefined }> = [
            { kind: 'premarket', at: next(days.map((d) => d.midnight + PREMARKET_AT * 60_000)) },
            { kind: 'intraday', at: next(days.flatMap((d) => INTRADAY_AT.map((m) => d.midnight + m * 60_000).filter((t) => t < d.close))) },
            { kind: 'close', at: next(days.map((d) => d.close + CLOSE_AFTER_MS)) },
            { kind: 'crypto', at: (Math.floor(now / CRYPTO_EVERY_MS) + 1) * CRYPTO_EVERY_MS },
        ];
        return rows.filter((r): r is { kind: PassKind; at: number } => r.at != null).sort((a, b) => a.at - b.at);
    }

    /** US trading days in range: New York midnight and the regular close. */
    private async tradingDays(from: number, to: number): Promise<Array<{ midnight: number; close: number }>> {
        const cal = await this.cached.market.bridges.alpaca?.calendar(from, to).catch(() => null);
        const out: Array<{ midnight: number; close: number }> = [];
        for (let t = from; t <= to; t += DAY_MS) {
            const [y, m, d] = localDate(NY, t).split('-').map(Number) as [number, number, number];
            const midnight = zonedWallTime(NY, y, m - 1, d, 0);
            if (out.some((x) => x.midnight === midnight)) continue;
            if (cal) {
                const day = cal.get(localDate(NY, t));
                if (day) out.push({ midnight, close: day.close });
            } else {
                const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
                if (wd !== 0 && wd !== 6) out.push({ midnight, close: zonedWallTime(NY, y, m - 1, d, 16 * 3_600_000) });
            }
        }
        return out;
    }

    status() {
        const p = this.pass;
        // A wait's cause changes between rounds (charting stopped, the quiet period ran out).
        const budgetWait = this.reason.startsWith('holding');
        return {
            state: this.state,
            reason: this.state === 'waiting' && !budgetWait ? this.waitReason() : this.reason,
            quietForMs: this.quietFor(),
            quietNeededMs: this.quietMs,
            share: BACKGROUND_SHARE,
            openCharts: this.hub.stats().topics,
            manualQueued: this.manual,
            pass: p
                ? { kind: p.kind, slot: p.slot, total: p.steps.length, index: p.index, done: p.done, skipped: p.skipped, failed: p.failed, calls: p.calls, startedAt: p.startedAt, current: p.steps[p.index]?.target ?? null }
                : null,
        };
    }
}
