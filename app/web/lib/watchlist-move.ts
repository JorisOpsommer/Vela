// Pure reorder rules for the watchlist's edit mode, kept apart from the DOM so they can be tested alone.

export interface WatchMoveGroup {
    symbols: string[];
}

/** A row's position: the group index and the row index inside that group. */
export interface WatchSlot {
    group: number;
    index: number;
}

/**
 * Moves the symbol at `from` to the insertion point `to`. `to.index` counts positions in the
 * target group as it stands before the move. A symbol appears at most once per group, so a
 * move into a group that already holds it is refused. Returns false when nothing changes.
 */
export function moveWatchSymbol(groups: WatchMoveGroup[], from: WatchSlot, to: WatchSlot): boolean {
    const src = groups[from.group]?.symbols;
    const dst = groups[to.group]?.symbols;
    if (!src || !dst || from.index < 0 || from.index >= src.length) return false;
    const sym = src[from.index]!;
    if (from.group === to.group) {
        const at = to.index > from.index ? to.index - 1 : to.index;
        if (at === from.index) return false;
        src.splice(from.index, 1);
        src.splice(Math.min(at, src.length), 0, sym);
        return true;
    }
    if (dst.includes(sym)) return false;
    src.splice(from.index, 1);
    dst.splice(Math.min(Math.max(to.index, 0), dst.length), 0, sym);
    return true;
}
