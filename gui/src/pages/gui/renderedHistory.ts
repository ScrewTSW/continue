import { ChatHistoryItem } from "core";

export interface RenderedHistoryItem<T> {
  item: T;
  /** Index in the unfiltered history array. */
  originalIndex: number;
}

/**
 * History minus the items that are never mapped, with each item's ORIGINAL
 * index preserved.
 *
 * Only `system` items are dropped here. `tool` items stay: `Chat.tsx` maps over
 * them and returns null per item, and removing them from the list would change
 * which items get mapped at all. They are excluded from *last* separately —
 * see `getLastRenderedIndex`.
 *
 * Using a positional index from the filtered array would desynchronise it from
 * `history`, which every consumer resolves against — `isLastUserInput`,
 * `sendInput`, `latestSummaryIndex`, `historyIndex` and `stepsOpen`, as well as
 * the `isLast` checks. Keeping the original index is what lets all of them
 * agree.
 */
export function getRenderedHistory<T extends Pick<ChatHistoryItem, "message">>(
  history: T[],
): RenderedHistoryItem<T>[] {
  return history
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => item.message.role !== "system");
}

/**
 * Original index of the last item that actually paints, or -1 when none does.
 *
 * Compare an item's original index against this to decide whether it is last.
 * `history.length - 1` is the wrong bound: a trailing `system` item is not in
 * the list at all, and a trailing `tool` item is mapped but renders null
 * (`Chat.tsx`), so either would point `isLast` at something invisible. A
 * cancelled agent turn ends on a tool result, so this is not hypothetical.
 *
 * Scans back rather than taking the tail, since a turn can end on a run of
 * several tool results.
 */
export function getLastRenderedIndex<
  T extends Pick<ChatHistoryItem, "message">,
>(rendered: RenderedHistoryItem<T>[]): number {
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (rendered[i].item.message.role !== "tool") {
      return rendered[i].originalIndex;
    }
  }
  return -1;
}
