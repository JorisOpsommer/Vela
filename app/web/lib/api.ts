// Same-origin JSON client. Every state-changing call carries the session's CSRF token;
// a lost session sends the browser back to the sign-in page.

export interface Me {
    id: number;
    username: string;
    role: 'admin' | 'user';
    totpEnabled: boolean;
    mustChangePassword: boolean;
}

let csrf = '';

export class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
        super(message);
    }
}

export function setCsrf(token: string): void {
    csrf = token;
}

export async function api<T>(
    path: string,
    init: { method?: string; body?: unknown; text?: string; keepalive?: boolean; redirectOn401?: boolean; headers?: Record<string, string>; onResponse?: (res: Response) => void } = {},
): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { ...init.headers };
    let body: string | undefined;
    if (init.text != null) {
        headers['Content-Type'] = 'text/plain; charset=utf-8';
        body = init.text;
    } else if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.body);
    }
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body, credentials: 'same-origin', keepalive: init.keepalive });
    init.onResponse?.(res);
    if (res.status === 401 && init.redirectOn401 !== false) {
        location.href = '/login';
        throw new ApiError('Not signed in.', 401);
    }
    const type = res.headers.get('content-type') ?? '';
    const data: unknown = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
        const obj = (typeof data === 'object' && data ? data : {}) as Record<string, unknown>;
        if (obj.mustChangePassword && !location.pathname.startsWith('/account')) location.href = '/account';
        throw new ApiError(typeof obj.error === 'string' ? obj.error : `Request failed (${res.status})`, res.status, obj);
    }
    return data as T;
}

export async function loadMe(): Promise<Me> {
    const r = await api<{ user: Me; csrf: string }>('/api/auth/me');
    setCsrf(r.csrf);
    return r.user;
}

export async function logout(): Promise<void> {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    location.href = '/login';
}
