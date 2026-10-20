// Per-account storage on the server, exposed through the chart's storage contract.
// Keys are preloaded before the workspace boots, so restores are synchronous (no flash of
// defaults); writes go out in the background, and a pending one survives tab close.
import type { VelaStorage } from '../../../src/widget';
import { api, ApiError } from './api';

export interface ServerStorage extends VelaStorage {
    /** Whether `key` had no saved value at boot (a first visit). */
    wasEmpty(key: string): boolean;
    /** Answer `key` with `value` until something is saved — first-visit defaults that are
     *  not written to the server unless the user changes them. */
    seed(key: string, value: string): void;
    flush(): void;
}

export async function createServerStorage(preload: string[]): Promise<ServerStorage> {
    const cache = new Map<string, string | null>();
    const empty = new Set<string>();
    await Promise.all(
        preload.map(async (key) => {
            try {
                const value = await api<string>(`/api/storage/${encodeURIComponent(key)}`);
                cache.set(key, typeof value === 'string' ? value : JSON.stringify(value));
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) {
                    cache.set(key, null);
                    empty.add(key);
                } else {
                    throw err;
                }
            }
        }),
    );

    const pending = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (keepalive: boolean) => {
        timer = null;
        for (const [key, value] of pending) {
            pending.delete(key);
            void api(`/api/storage/${encodeURIComponent(key)}`, { method: 'PUT', text: value, keepalive: keepalive && value.length < 60_000 }).catch((err: unknown) => {
                console.warn(`[storage] saving ${key} failed`, err);
            });
        }
    };
    window.addEventListener('pagehide', () => push(true));

    return {
        get(key) {
            if (cache.has(key)) return cache.get(key) ?? null;
            return api<string>(`/api/storage/${encodeURIComponent(key)}`).catch(() => null);
        },
        set(key, value) {
            cache.set(key, value);
            pending.set(key, value);
            timer ??= setTimeout(() => push(false), 400);
        },
        remove(key) {
            cache.set(key, null);
            pending.delete(key);
            void api(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
        },
        wasEmpty: (key) => empty.has(key),
        seed(key, value) {
            if (cache.get(key) == null) cache.set(key, value);
        },
        flush: () => push(false),
    };
}
