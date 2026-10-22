// First-paint timings for the cache page: how long a chart or the watchlist took to show
// prices, and whether they came from the server's cache. Best effort — a lost report is fine.
import { api } from './api';

export type TimingKind = 'complete' | 'cached' | 'cold' | 'quotes-cached' | 'quotes-cold';

export function reportTiming(kind: TimingKind, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    void api('/api/cache/timing', { method: 'POST', body: { kind, ms: Math.round(ms) }, redirectOn401: false }).catch(() => undefined);
}
