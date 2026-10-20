import './auth.css';

const form = document.getElementById('login') as HTMLFormElement;
const error = document.getElementById('error')!;
const codeRow = document.getElementById('code-row')!;
const button = form.querySelector('button')!;

function show(msg: string): void {
    error.textContent = msg;
    error.hidden = !msg;
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    show('');
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const code = String(data.get('code') ?? '').trim();
    if (!username || !password) return show('Enter your username and password.');
    button.disabled = true;
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password, ...(code ? { code } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; totpRequired?: boolean; user?: { mustChangePassword?: boolean } };
        if (res.ok) {
            location.href = body.user?.mustChangePassword ? '/account' : '/';
            return;
        }
        if (body.totpRequired) {
            codeRow.hidden = false;
            (form.elements.namedItem('code') as HTMLInputElement).focus();
        }
        show(body.error ?? 'Sign-in failed.');
    } catch {
        show('Network error — try again.');
    } finally {
        button.disabled = false;
    }
});

(form.elements.namedItem('username') as HTMLInputElement).focus();
