import { ChatHistoryItem } from "core";

/**
 * Duration of an item's reasoning span, in milliseconds.
 *
 * Reasoning timing is recorded on the history item (`startAt`/`endAt`) by the
 * session reducer, for both the `<think>`-tag path and the structured
 * `reasoning_content` path. Reading it from state rather than from a
 * component's own mount/unmount timing means the duration survives re-renders,
 * session reload, and — importantly — items that were never the last item in
 * history while streaming.
 *
 * Returns undefined when the span is still open or was never timed, so callers
 * can distinguish "still thinking" from "thought for 0s".
 */
export function reasoningElapsedMs(
  item: Pick<ChatHistoryItem, "reasoning">,
): number | undefined {
  const reasoning = item.reasoning;
  if (!reasoning?.startAt || !reasoning.endAt) {
    return undefined;
  }
  const elapsed = reasoning.endAt - reasoning.startAt;
  return elapsed >= 0 ? elapsed : undefined;
}
