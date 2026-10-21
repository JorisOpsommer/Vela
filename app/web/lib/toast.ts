// Small transient notices, stacked in the bottom-right corner. A notice with a `key`
// replaces its earlier copy instead of stacking, so a burst of failing requests (a chart
// loading history, several panes on one symbol) shows one toast, not ten.
import { providerName } from './providers';
import './toast.css';

export interface ToastOptions {
    key?: string;
    tone?: 'info' | 'warning' | 'market-open' | 'market-close';
    /** An emoji shown in place of the default icon. */
    icon?: string;
    title: string;
    body: string;
    link?: { href: string; label: string };
    timeoutMs?: number;
}

const WARNING_ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".8" fill="currentColor"/></svg>';

interface Card {
    el: HTMLElement;
    icon: HTMLElement;
    title: HTMLElement;
    body: HTMLElement;
    link: HTMLAnchorElement;
    timer?: ReturnType<typeof setTimeout>;
    timeoutMs: number;
    /** Pointer or focus is on it: it stays until they leave. */
    held: boolean;
}

let stack: HTMLElement | null = null;
const live = new Map<string, Card>();

function host(): HTMLElement {
    if (stack?.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.append(stack);
    return stack;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function dismiss(card: Card): void {
    clearTimeout(card.timer);
    for (const [k, v] of live) if (v === card) live.delete(k);
    card.el.classList.add('leaving');
    setTimeout(() => card.el.remove(), 180);
}

function arm(card: Card): void {
    clearTimeout(card.timer);
    if (!card.held) card.timer = setTimeout(() => dismiss(card), card.timeoutMs);
}

function newCard(): Card {
    const root = el('div', 'toast');
    const icon = el('span', 'toast-icon');
    const text = el('div', 'toast-text');
    const card: Card = { el: root, icon, title: el('div', 'toast-title'), body: el('div', 'toast-body'), link: el('a', 'toast-link') as HTMLAnchorElement, timeoutMs: 15_000, held: false };
    text.append(card.title, card.body, card.link);
    const close = el('button', 'toast-close', '×') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => dismiss(card);
    root.append(icon, text, close);
    const hold = (on: boolean) => () => {
        card.held = on;
        arm(card);
    };
    root.addEventListener('mouseenter', hold(true));
    root.addEventListener('mouseleave', hold(false));
    root.addEventListener('focusin', hold(true));
    root.addEventListener('focusout', hold(false));
    host().append(root);
    return card;
}

export function toast(opts: ToastOptions): void {
    // An update rewrites the text in place, so the buttons never move under the pointer.
    const card = (opts.key ? live.get(opts.key) : undefined) ?? newCard();
    if (opts.key) live.set(opts.key, card);
    card.el.className = `toast ${opts.tone ?? 'info'}`;
    card.el.setAttribute('role', opts.tone === 'warning' ? 'alert' : 'status');
    card.icon.className = opts.icon ? 'toast-icon emoji' : 'toast-icon';
    if (opts.icon) card.icon.textContent = opts.icon;
    else card.icon.innerHTML = WARNING_ICON;
    card.title.textContent = opts.title;
    card.body.textContent = opts.body;
    card.link.hidden = !opts.link;
    if (opts.link) {
        card.link.textContent = `${opts.link.label} →`;
        card.link.href = opts.link.href;
    }
    card.timeoutMs = opts.timeoutMs ?? 15_000;
    arm(card);
}

/** `60` → `1h`, `D` → `1D`: how the timeframe reads in the chart toolbar. */
function timeframeLabel(tf: string): string {
    const n = Number(tf);
    if (!Number.isFinite(n)) return /^\d/.test(tf) ? tf : `1${tf}`;
    return n % 60 === 0 ? `${n / 60}h` : `${n}m`;
}

function waitLabel(sec: number): string {
    if (sec < 60) return `${Math.max(5, Math.ceil(sec / 5) * 5)} seconds`;
    const m = Math.ceil(sec / 60);
    return m === 1 ? 'a minute' : `${m} minutes`;
}

function listNames(ids: string[]): string {
    const names = ids.map(providerName);
    return names.length <= 1 ? (names[0] ?? 'A data source') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface ProviderLimitNotice {
    providers: string[];
    retryAfterSec: number;
    symbol: string;
    timeframe: string;
}

export function showProviderLimit(n: ProviderLimitNotice): void {
    const who = listNames(n.providers);
    const verb = n.providers.length > 1 ? 'have' : 'has';
    toast({
        key: `limit:${[...n.providers].sort().join(',')}`,
        tone: 'warning',
        title: 'Rate limit reached',
        body: `${who} ${verb} no requests left for the moment, so ${n.symbol.split(':').pop()} · ${timeframeLabel(n.timeframe)} could not load. Try again in about ${waitLabel(n.retryAfterSec)}.`,
        link: { href: '/stats', label: 'See data providers' },
    });
}
