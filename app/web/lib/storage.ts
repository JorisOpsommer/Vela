// Per-account storage on the server, exposed through the chart's storage contract.
// Keys are preloaded before the workspace boots, so restores are synchronous (no flash of
// defaults); writes go out in the background, and a pending one survives tab close.
//
// Every value remembers the revision it was read or saved at. A save names that revision, and
// the server refuses it when another device has saved since: the newer value is pulled in and
// handed to `onRemote` listeners, so the stale tab shows the account's latest state instead of
// overwriting it. A tab that comes back into view pulls the latest value too.
import type { VelaStorage } from '../../../src/widget';
import { api, ApiError } from './api';

export interface ServerStorage extends VelaStorage {
    /** Whether `key` had no saved value at boot (a first visit). */
    wasEmpty(key: string): boolean;
    /** Answer `key` with `value` until something is saved — first-visit defaults that are
     *  not written to the server unless the user changes them. */
    seed(key: string, value: string): void;
    flush(): void;
    /** Call `cb` with the newer value whenever another device's save replaces `key`. */
    onRemote(key: string, cb: (value: string) => void): () => void;
}

export async function createServerStorage(preload: string[]): Promise<ServerStorage> {
    const cache = new Map<string, string | null>();
    /** The value the server holds as far as this tab knows (a write it accepted, or a read). */
    const synced = new Map<string, string | null>();
    /** The revision of each key's last read or accepted write — the base of the next write. */
    const revisions = new Map<string, number>();
    const empty = new Set<string>();
    const listeners = new Map<string, Set<(value: string) => void>>();
    const pending = new Map<string, string>();

    /** GET one key: its value and revision. Null when the key has no saved value. */
    const read = async (key: string): Promise<{ value: string; revision?: number } | null> => {
        let revision: number | undefined;
        try {
            const value = await api<string>(`/api/storage/${encodeURIComponent(key)}`, {
                onResponse: (res) => {
                    const header = res.headers.get('x-storage-revision');
                    revision = header == null ? undefined : Number(header);
                },
            });
            return { value: typeof value === 'string' ? value : JSON.stringify(value), revision };
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) return null;
            throw err;
        }
    };

    await Promise.all(
        preload.map(async (key) => {
            const r = await read(key);
            if (r) {
                cache.set(key, r.value);
                synced.set(key, r.value);
                if (r.revision !== undefined) revisions.set(key, r.revision);
            } else {
                cache.set(key, null);
                synced.set(key, null);
                empty.add(key);
            }
        }),
    );

    /** Pull `key` when the server holds a newer revision. A conflict (`refused`: our write was
     *  built on a stale revision) also drops the unsaved local edit — the newer save wins — and
     *  always notifies, because the open workspace must be re-applied either way. */
    const refresh = async (key: string, refused = false): Promise<void> => {
        if (!refused && pending.has(key)) return; // our unsaved edit goes out first
        let r: Awaited<ReturnType<typeof read>>;
        try {
            r = await read(key);
        } catch {
            return; // offline or signed out: the next visible/focus refresh tries again
        }
        if (!r) return;
        if (!refused && r.revision !== undefined && revisions.get(key) === r.revision) return;
        const changed = r.value !== cache.get(key);
        cache.set(key, r.value);
        synced.set(key, r.value);
        if (r.revision !== undefined) revisions.set(key, r.revision);
        if (refused) pending.delete(key);
        if (refused || changed) for (const cb of listeners.get(key) ?? []) cb(r.value);
    };

    /** Write one value on top of the revision it was built on. */
    const save = async (key: string, value: string, keepalive: boolean): Promise<void> => {
        const base = revisions.get(key);
        try {
            const saved = await api<{ revision?: number }>(`/api/storage/${encodeURIComponent(key)}`, {
                method: 'PUT',
                text: value,
                keepalive: keepalive && value.length < 60_000,
                headers: base === undefined ? undefined : { 'X-Base-Revision': String(base) },
            });
            synced.set(key, value);
            if (typeof saved?.revision === 'number') revisions.set(key, saved.revision);
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                generation.set(key, (generation.get(key) ?? 0) + 1);
                await refresh(key, true);
                return;
            }
            console.warn(`[storage] saving ${key} failed`, err);
        }
    };

    /** Saves of one key run one after another, each on the revision its predecessor left, so a
     *  tab's own second save is never refused by its first. A refused save bumps the key's
     *  generation, which drops the saves queued on the stale state. */
    const queue = new Map<string, Promise<void>>();
    const generation = new Map<string, number>();
    const enqueue = (key: string, value: string, keepalive: boolean): void => {
        const gen = generation.get(key) ?? 0;
        const run = (queue.get(key) ?? Promise.resolve()).then(() => ((generation.get(key) ?? 0) === gen ? save(key, value, keepalive) : undefined));
        queue.set(key, run);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (keepalive: boolean) => {
        timer = null;
        for (const [key, value] of pending) {
            pending.delete(key);
            enqueue(key, value, keepalive);
        }
    };
    window.addEventListener('pagehide', () => push(true));
    // A tab coming back into view (or focus) catches up with saves made on other devices.
    const catchUp = () => {
        if (document.hidden) return;
        for (const key of preload) void refresh(key);
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);

    return {
        get(key) {
            if (cache.has(key)) return cache.get(key) ?? null;
            return api<string>(`/api/storage/${encodeURIComponent(key)}`).catch(() => null);
        },
        set(key, value) {
            cache.set(key, value);
            // A value the server already holds (a workspace re-applied from another device)
            // is not written back — that would only bump its revision and echo to the other tab.
            if (synced.get(key) === value) {
                pending.delete(key);
                return;
            }
            pending.set(key, value);
            timer ??= setTimeout(() => push(false), 400);
        },
        remove(key) {
            cache.set(key, null);
            synced.set(key, null);
            revisions.delete(key);
            pending.delete(key);
            void api(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
        },
        wasEmpty: (key) => empty.has(key),
        seed(key, value) {
            if (cache.get(key) == null) cache.set(key, value);
        },
        flush: () => push(false),
        onRemote(key, cb) {
            const set = listeners.get(key) ?? new Set<(value: string) => void>();
            listeners.set(key, set);
            set.add(cb);
            return () => set.delete(cb);
        },
    };
}
