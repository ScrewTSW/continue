import { describe, expect, it } from "vitest";
import { getLastRenderedIndex, getRenderedHistory } from "./renderedHistory";

const h = (...roles: string[]) =>
  roles.map((role, i) => ({
    message: { role, content: "", id: `m-${i}` },
  })) as any[];

const lastOf = (...roles: string[]) =>
  getLastRenderedIndex(getRenderedHistory(h(...roles)));

describe("getRenderedHistory", () => {
  it("drops system items and keeps original indices", () => {
    const rendered = getRenderedHistory(h("system", "user", "thinking"));

    expect(rendered.map((r) => r.item.message.role)).toEqual([
      "user",
      "thinking",
    ]);
    // Positional indices would be 0,1 — which is exactly the bug.
    expect(rendered.map((r) => r.originalIndex)).toEqual([1, 2]);
  });

  it("is an identity mapping when there is no system item", () => {
    const rendered = getRenderedHistory(h("user", "assistant", "thinking"));
    expect(rendered.map((r) => r.originalIndex)).toEqual([0, 1, 2]);
  });

  it("handles multiple and interleaved system items", () => {
    const rendered = getRenderedHistory(
      h("system", "user", "system", "thinking"),
    );
    expect(rendered.map((r) => r.originalIndex)).toEqual([1, 3]);
  });

  it("returns nothing for empty or system-only history", () => {
    expect(getRenderedHistory(h())).toEqual([]);
    expect(getRenderedHistory(h("system", "system"))).toEqual([]);
  });
});

describe("getLastRenderedIndex", () => {
  it("identifies the trailing thinking item behind a system item", () => {
    // The regression: with a leading system item, a filtered-position check
    // compared 1 against 2 and concluded the last item was not last, so an
    // empty thinking item was dropped mid-stream.
    expect(lastOf("system", "user", "thinking")).toBe(2);
  });

  it("matches the plain case with no system item", () => {
    expect(lastOf("user", "thinking")).toBe(1);
  });

  it("ignores a trailing system item", () => {
    // `history.length - 1` would be 2 here and match nothing rendered.
    expect(lastOf("user", "thinking", "system")).toBe(1);
  });

  it("ignores a trailing tool result", () => {
    // `Chat.tsx` returns null for tool items, so they occupy a history slot but
    // paint nothing. A cancelled agent turn ends exactly here; pointing `isLast`
    // at the tool item means no *visible* item is last, which is the same
    // failure as the system-item case.
    expect(lastOf("user", "thinking", "assistant", "tool")).toBe(2);
  });

  it("ignores a run of trailing tool results", () => {
    expect(lastOf("user", "assistant", "tool", "tool")).toBe(1);
  });

  it("keeps tool items that are not trailing out of the way", () => {
    // A tool result mid-turn must not shift the last index off the final
    // assistant message.
    expect(lastOf("user", "assistant", "tool", "assistant")).toBe(3);
  });

  it("returns -1 when nothing renders", () => {
    expect(lastOf()).toBe(-1);
    expect(lastOf("system")).toBe(-1);
    // Nothing paints: every item is either filtered out or renders null.
    expect(lastOf("tool")).toBe(-1);
    expect(lastOf("system", "tool")).toBe(-1);
  });

  it("never marks a non-final rendered item as last", () => {
    const rendered = getRenderedHistory(h("system", "user", "thinking"));
    const last = getLastRenderedIndex(rendered);
    const flagged = rendered.filter((r) => r.originalIndex === last);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].item.message.role).toBe("thinking");
  });
});
