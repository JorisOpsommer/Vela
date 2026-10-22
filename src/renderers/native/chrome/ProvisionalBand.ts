// The catch-up band: while a chart shows bars its source already held and the newest
// stretch is still on its way, the plot from the last held bar to the right edge carries a
// soft shimmer, faint ghost candles in the slots still to come, and a pulsing dot on the
// last held close. When the real bars land the band withdraws left to right, uncovering
// them; when the load came back without them it settles into a still hatch. DOM-only and
// animated through Web Animations, so no stylesheet crosses the renderer boundary.

export interface ProvisionalBandGeometry {
    /** Plot-relative x of the boundary (the right edge of the last held bar's slot). */
    left: number;
    /** Plot data width (the band ends at the price scale). */
    right: number;
    height: number;
    /** Center-to-center bar pitch and candle body width, px. */
    pitch: number;
    body: number;
    /** The last held close on the price pane, or null when off the pane. */
    closeY: number | null;
    dpr: number;
}

export interface ProvisionalBandColors {
    text: string;
    background: string;
}

const SHIMMER_MS = 1_500;
const REVEAL_MS = 450;
const MAX_GHOSTS = 300;

export class ProvisionalBand {
    readonly el: HTMLDivElement;
    private readonly shimmer: HTMLDivElement;
    private readonly ghosts: HTMLCanvasElement;
    private readonly dot: HTMLDivElement;
    private status: 'syncing' | 'stale' | null = null;
    private colors: ProvisionalBandColors = { text: '#888', background: 'transparent' };
    private geomSig = '';
    private ghostSig = '';
    private shimmerAnim: Animation | null = null;
    private dotAnim: Animation | null = null;
    private revealAnim: Animation | null = null;

    constructor(doc: Document) {
        this.el = doc.createElement('div');
        this.el.className = 'vela-provisional'; // stable hook for probes and host styling
        this.el.setAttribute('aria-hidden', 'true');
        Object.assign(this.el.style, { position: 'absolute', top: '0', left: '0', width: '0', height: '0', overflow: 'hidden', pointerEvents: 'none', display: 'none' });
        this.ghosts = doc.createElement('canvas');
        Object.assign(this.ghosts.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
        this.shimmer = doc.createElement('div');
        Object.assign(this.shimmer.style, { position: 'absolute', top: '0', bottom: '0', left: '0', width: '45%', pointerEvents: 'none' });
        this.dot = doc.createElement('div');
        Object.assign(this.dot.style, { position: 'absolute', left: '-4px', width: '8px', height: '8px', borderRadius: '50%', pointerEvents: 'none', display: 'none' });
        this.el.append(this.ghosts, this.shimmer, this.dot);
    }

    private get reducedMotion(): boolean {
        return this.el.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    }

    /** Show the band in `status`, end it (`null`), or withdraw it over the real bars (`reveal`). */
    set(status: 'syncing' | 'stale' | null, colors: ProvisionalBandColors, opts: { reveal?: boolean } = {}): void {
        this.colors = colors;
        if (status == null) {
            this.stopLoops();
            if (opts.reveal && this.status != null && this.el.style.display !== 'none' && !this.reducedMotion && typeof this.el.animate === 'function') {
                this.revealAnim?.cancel();
                // Only the wash withdraws: ghosts and shimmer must not sit on the real bars.
                this.ghosts.style.display = 'none';
                this.shimmer.style.display = 'none';
                this.dot.style.display = 'none';
                this.revealAnim = this.el.animate(
                    [
                        { clipPath: 'inset(0 0 0 0)', opacity: 1 },
                        { clipPath: 'inset(0 0 0 100%)', opacity: 0.4 },
                    ],
                    { duration: REVEAL_MS, easing: 'cubic-bezier(.2,.7,.2,1)' },
                );
                const anim = this.revealAnim;
                anim.onfinish = () => {
                    if (this.revealAnim !== anim) return;
                    this.revealAnim = null;
                    if (this.status == null) this.hide();
                };
            } else {
                this.hide();
            }
            this.status = null;
            return;
        }
        this.revealAnim?.cancel();
        this.revealAnim = null;
        this.status = status;
        this.geomSig = '';
        this.ghostSig = '';
        this.ghosts.style.display = '';
        this.dress();
    }

    /** Showing, or withdrawing over freshly landed bars — the plot geometry still matters. */
    get visible(): boolean {
        return this.status != null || this.revealAnim != null;
    }

    private hide(): void {
        this.el.style.display = 'none';
        this.geomSig = '';
    }

    private stopLoops(): void {
        this.shimmerAnim?.cancel();
        this.shimmerAnim = null;
        this.dotAnim?.cancel();
        this.dotAnim = null;
    }

    /** Colors and motion for the current status. */
    private dress(): void {
        const { text, background } = this.colors;
        const ink = (pct: number) => `color-mix(in srgb, ${text} ${pct}%, transparent)`;
        const stale = this.status === 'stale';
        this.el.style.background = stale
            ? `repeating-linear-gradient(135deg, ${ink(7)} 0 1px, transparent 1px 7px), color-mix(in srgb, ${background} 72%, transparent)`
            : `linear-gradient(90deg, color-mix(in srgb, ${background} 55%, transparent), color-mix(in srgb, ${background} 80%, transparent))`;
        this.el.style.borderLeft = `1px dashed ${ink(stale ? 28 : 40)}`;
        this.shimmer.style.background = `linear-gradient(90deg, transparent, ${ink(9)}, transparent)`;
        this.shimmer.style.display = stale ? 'none' : '';
        this.dot.style.background = ink(stale ? 35 : 75);
        this.stopLoops();
        if (stale || this.reducedMotion || typeof this.shimmer.animate !== 'function') return;
        this.shimmerAnim = this.shimmer.animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(240%)' }], { duration: SHIMMER_MS, iterations: Infinity, easing: 'ease-in-out' });
        this.dotAnim = this.dot.animate(
            [
                { transform: 'scale(1)', opacity: 0.9 },
                { transform: 'scale(1.6)', opacity: 0.35 },
            ],
            { duration: 900, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' },
        );
    }

    /** Follow the plot: called every data frame; writes the DOM only when something moved. */
    sync(g: ProvisionalBandGeometry | null): void {
        if (!this.visible) return;
        const left = g ? Math.max(0, Math.round(g.left)) : 0;
        const width = g ? Math.max(0, Math.round(g.right) - left) : 0;
        if (!g || width < 2) {
            this.hide();
            return;
        }
        const sig = `${left},${width},${Math.round(g.height)},${g.closeY == null ? '' : Math.round(g.closeY)}`;
        if (sig !== this.geomSig) {
            this.geomSig = sig;
            Object.assign(this.el.style, { display: '', left: `${left}px`, width: `${width}px`, height: `${Math.round(g.height)}px` });
            if (g.closeY == null || this.status == null) this.dot.style.display = 'none';
            else Object.assign(this.dot.style, { display: '', top: `${Math.round(g.closeY) - 4}px` });
        }
        if (this.status != null) this.paintGhosts(g, left, width);
    }

    /** Faint hollow candles in the slots still to come, wandering around the last close. */
    private paintGhosts(g: ProvisionalBandGeometry, left: number, width: number): void {
        const sig = `${width},${Math.round(g.height)},${g.pitch.toFixed(2)},${g.body.toFixed(2)},${g.closeY == null ? '' : Math.round(g.closeY)},${left - g.left},${g.dpr},${this.status},${this.colors.text}`;
        if (sig === this.ghostSig) return;
        this.ghostSig = sig;
        const c = this.ghosts;
        c.width = Math.max(1, Math.round(width * g.dpr));
        c.height = Math.max(1, Math.round(g.height * g.dpr));
        c.style.width = `${width}px`;
        c.style.height = `${Math.round(g.height)}px`;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
        ctx.clearRect(0, 0, width, g.height);
        if (g.closeY == null || g.pitch < 2) return;
        // The band may start left of the plot (scrolled): slots stay on the bar grid.
        const shift = left - g.left;
        const bodyW = Math.max(1, Math.min(g.body * 0.7, g.pitch - 1));
        ctx.strokeStyle = this.colors.text;
        ctx.lineWidth = 1;
        let y = g.closeY;
        for (let k = 0; k < MAX_GHOSTS; k++) {
            const x = g.pitch / 2 + k * g.pitch - shift;
            if (x - bodyW / 2 > width) break;
            // Deterministic wander, so a repaint never jitters the ghosts.
            const r = Math.sin((k + 1) * 12.9898) * 43758.5453;
            const n = r - Math.floor(r);
            const body = 4 + n * 14;
            y += (n - 0.5) * 10;
            ctx.globalAlpha = Math.max(0.04, 0.22 * (1 - k / 40));
            if (x + bodyW / 2 < 0) continue;
            const top = Math.round(y - body / 2) + 0.5;
            const xl = Math.round(x - bodyW / 2) + 0.5;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, top - 4 - n * 6);
            ctx.lineTo(Math.round(x) + 0.5, top + body + 4 + (1 - n) * 6);
            ctx.stroke();
            ctx.clearRect(xl - 0.5, top - 0.5, Math.round(bodyW) + 1, Math.round(body) + 1);
            ctx.strokeRect(xl, top, Math.round(bodyW), Math.round(body));
        }
        ctx.globalAlpha = 1;
    }

    destroy(): void {
        this.stopLoops();
        this.revealAnim?.cancel();
        this.el.remove();
    }
}
