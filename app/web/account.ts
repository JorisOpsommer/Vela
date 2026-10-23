import './auth.css';
import { api, ApiError, loadMe, logout, type Me } from './lib/api';
import { startMarketBell } from './lib/market-bell';

interface AdminUser {
    id: number;
    username: string;
    role: 'admin' | 'user';
    totpEnabled: boolean;
    disabled: boolean;
    mustChangePassword: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setMsg(form: HTMLElement, text: string, ok: boolean): void {
    const m = form.querySelector<HTMLElement>('.msg') ?? $('admin-msg');
    m.textContent = text;
    m.className = `msg ${ok ? 'ok' : 'bad'}`;
}

function errText(err: unknown): string {
    return err instanceof ApiError ? err.message : 'Something went wrong.';
}

function cell(text: string): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
}

interface ActivityRow {
    id: number;
    username: string;
    disabled: boolean;
    opens: Record<string, number>;
    minutes: Record<string, number>;
    lastActiveAt: number | null;
}

/** Keys of the server's activity windows, shortest first (see ACTIVITY_WINDOWS). */
const OPEN_WINDOWS = ['m15', 'h1', 'h12', 'h24', 'd7'];

function formatMinutes(total: number): string {
    if (total < 60) return `${total} min`;
    return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

async function main(): Promise<void> {
    const me = await loadMe();
    startMarketBell();
    $('who').textContent = `Signed in as ${me.username}${me.role === 'admin' ? ' (admin)' : ''}`;
    $('signout').onclick = () => void logout();
    $('must-change').hidden = !me.mustChangePassword;
    $('back').hidden = me.mustChangePassword;

    const pw = $<HTMLFormElement>('password-form');
    pw.onsubmit = async (e) => {
        e.preventDefault();
        const d = new FormData(pw);
        if (d.get('next') !== d.get('repeat')) return setMsg(pw, 'The new passwords do not match.', false);
        try {
            await api('/api/auth/password', { method: 'POST', body: { current: d.get('current'), next: d.get('next') } });
            pw.reset();
            setMsg(pw, 'Password updated.', true);
            if (me.mustChangePassword) setTimeout(() => (location.href = '/'), 600);
        } catch (err) {
            setMsg(pw, errText(err), false);
        }
    };

    renderTotp(me);
    if (me.role === 'admin' && !me.mustChangePassword) {
        $('admin').hidden = false;
        await renderUsers(me);
        await renderBridges();
        const add = $<HTMLFormElement>('add-user');
        add.onsubmit = async (e) => {
            e.preventDefault();
            const d = new FormData(add);
            try {
                await api('/api/admin/users', { method: 'POST', body: { username: d.get('username'), password: d.get('password'), role: d.get('role') } });
                add.reset();
                setMsg($('admin'), 'User added. Share the temporary password with them privately.', true);
                await renderUsers(me);
            } catch (err) {
                setMsg($('admin'), errText(err), false);
            }
        };
        $('activity-card').hidden = false;
        $('activity-refresh').onclick = async () => {
            $('activity-msg').textContent = '';
            try {
                await renderActivity();
            } catch (err) {
                setMsg($('activity-card'), errText(err), false);
            }
        };
        await renderActivity();
    }
}

function renderTotp(me: Me): void {
    $('totp-on').hidden = !me.totpEnabled;
    $('totp-off').hidden = me.totpEnabled;
    $('totp-start').onclick = async () => {
        try {
            const r = await api<{ secret: string; qrSvg: string }>('/api/auth/totp/setup', { method: 'POST', body: {} });
            // The server renders the QR code; it contains no user-supplied markup.
            $('totp-qr').innerHTML = r.qrSvg;
            $('totp-secret').textContent = r.secret;
            $('totp-setup').hidden = false;
            $('totp-start').hidden = true;
        } catch (err) {
            alert(errText(err));
        }
    };
    const confirmForm = $<HTMLFormElement>('totp-confirm');
    confirmForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
            await api('/api/auth/totp/confirm', { method: 'POST', body: { code: String(new FormData(confirmForm).get('code') ?? '').trim() } });
            me.totpEnabled = true;
            renderTotp(me);
        } catch (err) {
            setMsg(confirmForm, errText(err), false);
        }
    };
    const disableForm = $<HTMLFormElement>('totp-disable');
    disableForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
            await api('/api/auth/totp/disable', { method: 'POST', body: { password: new FormData(disableForm).get('password') } });
            disableForm.reset();
            me.totpEnabled = false;
            $('totp-setup').hidden = true;
            $('totp-start').hidden = false;
            renderTotp(me);
        } catch (err) {
            setMsg(disableForm, errText(err), false);
        }
    };
}

async function renderUsers(me: Me): Promise<void> {
    const { users } = await api<{ users: AdminUser[] }>('/api/admin/users');
    const tbody = $('users');
    tbody.replaceChildren(
        ...users.map((u) => {
            const tr = document.createElement('tr');
            tr.append(cell(u.username), cell(u.role), cell(u.totpEnabled ? 'on' : '—'), cell(u.disabled ? 'disabled' : u.mustChangePassword ? 'must change password' : 'active'));
            const actions = document.createElement('td');
            const btn = (label: string, fn: () => Promise<unknown>, danger = false) => {
                const b = document.createElement('button');
                b.className = `small${danger ? ' danger' : ''}`;
                b.textContent = label;
                b.onclick = async () => {
                    try {
                        await fn();
                        await renderUsers(me);
                    } catch (err) {
                        setMsg($('admin'), errText(err), false);
                    }
                };
                return b;
            };
            if (u.id !== me.id) {
                actions.append(
                    btn(u.role === 'admin' ? 'Make user' : 'Make admin', () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'user' : 'admin' } })),
                    btn(u.disabled ? 'Enable' : 'Disable', () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } })),
                    btn('Reset password', async () => {
                        const p = prompt(`Temporary password for ${u.username} (12+ characters):`);
                        if (!p) return;
                        await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { password: p } });
                        setMsg($('admin'), `Password reset. ${u.username} must change it at next sign-in.`, true);
                    }),
                );
                if (u.totpEnabled) actions.append(btn('Reset 2FA', () => api(`/api/admin/users/${u.id}/reset-totp`, { method: 'POST', body: {} })));
                actions.append(
                    btn(
                        'Delete',
                        async () => {
                            if (confirm(`Delete ${u.username} and their saved charts?`)) await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
                        },
                        true,
                    ),
                );
            }
            tr.append(actions);
            return tr;
        }),
    );
}

async function renderActivity(): Promise<void> {
    const { users } = await api<{ users: ActivityRow[] }>('/api/admin/activity');
    $('activity').replaceChildren(
        ...users.map((u) => {
            const tr = document.createElement('tr');
            tr.append(
                cell(u.disabled ? `${u.username} (disabled)` : u.username),
                ...OPEN_WINDOWS.map((w) => cell(String(u.opens[w] ?? 0))),
                cell(formatMinutes(u.minutes.d7 ?? 0)),
                cell(u.lastActiveAt == null ? 'never' : new Date(u.lastActiveAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
            );
            return tr;
        }),
    );
}

async function renderBridges(): Promise<void> {
    const labels: Record<string, string> = { alpaca: 'Alpaca (US stocks, crypto)', finnhub: 'Finnhub (live trades, logos)', yahoo: 'Yahoo Finance (indices, futures, FX)', coinbase: 'Coinbase (crypto)', energycharts: 'Energy-Charts (Belgian power)' };
    const { bridges } = await api<{ bridges: Record<string, { configured: boolean; healthy: boolean }> }>('/api/status');
    $('bridges').replaceChildren(
        ...Object.entries(bridges).map(([id, s]) => {
            const li = document.createElement('li');
            li.className = !s.configured ? 'off' : s.healthy ? 'ok' : 'down';
            li.textContent = `${labels[id] ?? id} — ${!s.configured ? 'not configured' : s.healthy ? 'ok' : 'failing'}`;
            return li;
        }),
    );
}

main().catch((err: unknown) => console.error(err));
