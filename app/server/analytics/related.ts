// The local relationship map (config/related.json) and the suggestion engine built on
// it. Everything runs on this server — no external service sees what anyone browses.
import fs from 'node:fs';
import path from 'node:path';

export interface RelatedEntry {
    n: string;
    s: string;
    i: string;
    t: string[];
    p: string[];
}

export interface Suggestion {
    symbol: string;
    name: string;
    sector: string;
    industry: string;
    score: number;
    /** Why: the user's symbols that lead here, strongest first. */
    because: string[];
    /** Themes the candidate shares with the user's interests. */
    themes: string[];
    /** `peer` (explicit relation), `industry`, or `theme` — the strongest link kind. */
    link: 'peer' | 'industry' | 'theme';
}

/** Sector/industry/theme links are weaker than an explicit peer relation. */
const W_PEER = 1;
const W_INDUSTRY = 0.55;
const W_SECTOR = 0.15;
const W_THEMES = 0.8;
/** Diversity: a candidate's score is discounted by its similarity to ones already picked. */
const MMR_LAMBDA = 0.72;
/**
 * With a random source, each candidate's relevance is scaled by a log-normal factor of this
 * spread: close matches usually trade places, and now and then a weaker one gets a large
 * enough lift to show up.
 */
const SPREAD = 0.25;

/** Themes too broad to say anything about a pairing. */
const WEAK_TAGS = new Set(['megacap', 'dividend', 'value', 'growth', 'etf', 'index', 'speculative', 'momentum']);

/** A standard normal draw from a uniform source (Box–Muller). */
function gaussian(random: () => number): number {
    return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

export class RelatedMap {
    readonly symbols: Map<string, RelatedEntry>;
    private readonly peers = new Map<string, Set<string>>();
    private readonly idf = new Map<string, number>();

    constructor(doc: { symbols: Record<string, RelatedEntry> }) {
        this.symbols = new Map(Object.entries(doc.symbols).map(([k, v]) => [k.toUpperCase(), v]));
        for (const [sym, e] of this.symbols) {
            for (const p of e.p) {
                const peer = p.toUpperCase();
                if (!this.symbols.has(peer) || peer === sym) continue;
                this.link(sym, peer);
                this.link(peer, sym);
            }
        }
        const df = new Map<string, number>();
        for (const e of this.symbols.values()) for (const t of new Set(e.t)) df.set(t, (df.get(t) ?? 0) + 1);
        const n = this.symbols.size;
        // Rare themes ("uranium") say more than common ones ("dividend").
        for (const [t, d] of df) this.idf.set(t, (WEAK_TAGS.has(t) ? 0.35 : 1) * Math.log(1 + n / d));
    }

    static load(configDir: string): RelatedMap {
        const file = path.join(configDir, 'related.json');
        if (!fs.existsSync(file)) return new RelatedMap({ symbols: {} });
        return new RelatedMap(JSON.parse(fs.readFileSync(file, 'utf8')) as { symbols: Record<string, RelatedEntry> });
    }

    private link(a: string, b: string): void {
        let set = this.peers.get(a);
        if (!set) this.peers.set(a, (set = new Set()));
        set.add(b);
    }

    get(symbol: string): RelatedEntry | undefined {
        return this.symbols.get(symbol.toUpperCase());
    }

    peersOf(symbol: string): string[] {
        return [...(this.peers.get(symbol.toUpperCase()) ?? [])];
    }

    /** Weighted theme overlap in [0, 1]. */
    private themeSim(a: RelatedEntry, b: RelatedEntry): { sim: number; shared: string[] } {
        const sa = new Set(a.t);
        const sb = new Set(b.t);
        let inter = 0;
        let union = 0;
        const shared: string[] = [];
        for (const t of new Set([...sa, ...sb])) {
            const w = this.idf.get(t) ?? 1;
            union += w;
            if (sa.has(t) && sb.has(t)) {
                inter += w;
                if (!WEAK_TAGS.has(t)) shared.push(t);
            }
        }
        return { sim: union > 0 ? inter / union : 0, shared };
    }

    /** Similarity of two symbols, and the strongest kind of link between them. */
    similarity(a: string, b: string): { score: number; link: Suggestion['link']; shared: string[] } {
        const ea = this.get(a);
        const eb = this.get(b);
        if (!ea || !eb || a === b) return { score: 0, link: 'theme', shared: [] };
        const peer = this.peers.get(a)?.has(b) ?? false;
        const industry = ea.i === eb.i;
        const sector = ea.s === eb.s;
        const { sim, shared } = this.themeSim(ea, eb);
        const score = (peer ? W_PEER : 0) + (industry ? W_INDUSTRY : 0) + (sector ? W_SECTOR : 0) + W_THEMES * sim;
        return { score, link: peer ? 'peer' : industry ? 'industry' : 'theme', shared };
    }

    /**
     * Rank symbols the user has not looked at by how strongly they connect to what they
     * have, weighted by interest. Picks are diversified so one cluster cannot fill the list.
     * Pass `random` to vary the picks between calls, mostly among comparably strong matches
     * and occasionally reaching a weaker one; without it the result is deterministic.
     */
    suggest(profile: Map<string, number>, exclude: Set<string>, limit = 12, random?: () => number): Suggestion[] {
        const known = [...profile.entries()].filter(([s, w]) => w > 0 && this.symbols.has(s));
        if (known.length === 0) return [];
        const total = known.reduce((a, [, w]) => a + w, 0);
        const scored: Array<Suggestion & { raw: number }> = [];
        for (const [cand, e] of this.symbols) {
            if (exclude.has(cand) || profile.has(cand)) continue;
            let raw = 0;
            const contrib: Array<[string, number]> = [];
            const themes = new Map<string, number>();
            let best: Suggestion['link'] = 'theme';
            for (const [sym, w] of known) {
                const s = this.similarity(sym, cand);
                if (s.score < 0.12) continue;
                const c = (w / total) * s.score;
                raw += c;
                contrib.push([sym, c]);
                for (const t of s.shared) themes.set(t, (themes.get(t) ?? 0) + c);
                if (s.link === 'peer' || (s.link === 'industry' && best === 'theme')) best = s.link;
            }
            if (raw <= 0) continue;
            contrib.sort((a, b) => b[1] - a[1]);
            scored.push({
                symbol: cand,
                name: e.n,
                sector: e.s,
                industry: e.i,
                raw,
                score: 0,
                // Only the symbols that really drive the match, not every faint link.
                because: contrib.filter(([, c]) => c >= contrib[0]![1] * 0.35).slice(0, 3).map(([s]) => s),
                themes: [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
                link: best,
            });
        }
        scored.sort((a, b) => b.raw - a.raw);
        const pool = scored.slice(0, limit * 6);
        const top = pool[0]?.raw ?? 1;
        const factor = new Map(pool.map((c) => [c.symbol, random ? Math.exp(SPREAD * gaussian(random)) : 1]));
        const picked: Array<Suggestion & { raw: number }> = [];
        while (picked.length < limit && pool.length > 0) {
            let bestIdx = 0;
            let bestVal = -Infinity;
            for (let i = 0; i < pool.length; i++) {
                const c = pool[i]!;
                const redundancy = picked.reduce((m, p) => Math.max(m, Math.min(1, this.similarity(p.symbol, c.symbol).score / 1.5)), 0);
                const val = MMR_LAMBDA * (c.raw / top) * factor.get(c.symbol)! - (1 - MMR_LAMBDA) * redundancy;
                if (val > bestVal) [bestVal, bestIdx] = [val, i];
            }
            picked.push(pool.splice(bestIdx, 1)[0]!);
        }
        return picked.map(({ raw, ...s }) => ({ ...s, score: Math.round((raw / top) * 100) / 100 }));
    }

    /** The user's interest by theme, normalised to the strongest = 1. */
    themes(profile: Map<string, number>, limit = 10): Array<{ theme: string; weight: number }> {
        const acc = new Map<string, number>();
        for (const [sym, w] of profile) {
            const e = this.get(sym);
            if (!e) continue;
            for (const t of e.t) if (!WEAK_TAGS.has(t)) acc.set(t, (acc.get(t) ?? 0) + w * (this.idf.get(t) ?? 1));
        }
        const rows = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
        const max = rows[0]?.[1] ?? 1;
        return rows.map(([theme, w]) => ({ theme, weight: Math.round((w / max) * 100) / 100 }));
    }
}
