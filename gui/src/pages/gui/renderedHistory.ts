import { ChatHistoryItem } from "core";

export interface RenderedHistoryItem<T> {
  item: T;
  /** Index in the unfiltered history array. */
  originalIndex: number;
}

/**
 * History filtered to what is actually rendered, with each item's ORIGINAL
 * index preserved.
 *
 * System items are never rendered. Using a positional index from the filtered
 * array would desynchronise it from `history`, which every consumer resolves
 * against — `isLastUserInput`, `sendInput`, `latestSummaryIndex`,
 * `historyIndex` and `stepsOpen`, as well as the `isLast` checks. Keeping the
 * original index is what lets all of them agree.
 */
export function getRenderedHistory<T extends Pick<ChatHistoryItem, "message">>(
  history: T[],
): RenderedHistoryItem<T>[] {
  return history
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => item.message.role !== "system");
}

/**
 * Original index of the final rendered item, or -1 when nothing renders.
 *
 * Compare an item's original index against this to decide whether it is last.
 * A trailing system item means the last *rendered* item is not the last item
 * in history, so `history.length - 1` is the wrong bound.
 */
export function getLastRenderedIndex(
  rendered: RenderedHistoryItem<unknown>[],
): number {
  return rendered.length > 0 ? rendered[rendered.length - 1].originalIndex : -1;
}
