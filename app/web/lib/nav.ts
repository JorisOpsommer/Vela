// The header shared by the gradient pages.
import type { Me } from './api';
import { logout } from './api';

const TABS: Array<{ href: string; label: string }> = [
    { href: '/', label: 'Charts' },
    { href: '/insights', label: 'Insights' },
    { href: '/stats', label: 'Data providers' },
    { href: '/account', label: 'Account' },
];

export function mountNav(me: Me): void {
    const nav = document.createElement('nav');
    nav.className = 'topnav';
    const brand = document.createElement('a');
    brand.className = 'brand';
    brand.href = '/';
    const logo = document.createElement('img');
    logo.src = '/favicon.svg';
    logo.width = 22;
    logo.height = 22;
    logo.alt = '';
    brand.append(logo, document.createTextNode('Charts'));
    nav.append(brand);
    for (const t of TABS) {
        const a = document.createElement('a');
        a.className = `tab${location.pathname === t.href ? ' current' : ''}`;
        a.href = t.href;
        a.textContent = t.label;
        nav.append(a);
    }
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = me.username;
    const out = document.createElement('a');
    out.className = 'tab';
    out.href = '#';
    out.textContent = 'Sign out';
    out.onclick = (e) => {
        e.preventDefault();
        void logout();
    };
    nav.append(spacer, who, out);
    document.body.prepend(nav);
}
