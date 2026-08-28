import { describe, expect, it } from "vitest";
import { reasoningElapsedMs } from "./reasoningDuration";

const item = (reasoning: any) => ({ reasoning }) as any;

describe("reasoningElapsedMs", () => {
  it("returns the span duration", () => {
    expect(reasoningElapsedMs(item({ startAt: 1_000, endAt: 3_500 }))).toBe(
      2500,
    );
  });

  it("returns undefined while the span is still open", () => {
    expect(
      reasoningElapsedMs(item({ startAt: 1_000, active: true })),
    ).toBeUndefined();
  });

  it("returns undefined when the item was never timed", () => {
    expect(reasoningElapsedMs(item(undefined))).toBeUndefined();
    expect(reasoningElapsedMs(item({}))).toBeUndefined();
  });

  it("treats a zero timestamp as a real value, not as missing", () => {
    // Epoch 0 is falsy. A `!startAt` guard would discard this span and report
    // no duration at all.
    expect(reasoningElapsedMs(item({ startAt: 0, endAt: 250 }))).toBe(250);
    expect(reasoningElapsedMs(item({ startAt: 0, endAt: 0 }))).toBe(0);
  });

  it("returns undefined when the clock ran backwards", () => {
    expect(
      reasoningElapsedMs(item({ startAt: 5_000, endAt: 1_000 })),
    ).toBeUndefined();
  });
});
