import { describe, expect, it } from "vitest";

import { ChatMessage } from "core";
import sessionReducer, {
  newSession,
  setActive,
  streamUpdate,
} from "./sessionSlice";

/**
 * Regression tests for x_progress transport metadata.
 *
 * The orchestrator attaches a running `x_progress` object to streaming chunks.
 * It is transport telemetry, not conversation content: it must land in
 * `state.xProgress` and must NOT be persisted onto the stored chat message.
 *
 * The reducer must extract it WITHOUT mutating `action.payload` — Redux does
 * not freeze payloads, so mutation silently "works" while breaking action
 * replay, devtools time-travel, and any second reducer observing the action.
 */

const xProgress = {
  gen: 12,
  think: 3,
  prompt: 40,
  elapsed: 1.5,
  tok_s: 8.1,
  ctx_size: 4096,
  ctx_used: 512,
};

/** A session with one user turn and an assistant placeholder, as production has. */
function startedState() {
  let state = sessionReducer(undefined, newSession());
  state = sessionReducer(state, {
    type: "session/submitEditorAndInitAtIndex/fulfilled",
    payload: undefined,
  } as any);
  // Build the history shape directly: [user, assistant placeholder]
  return {
    ...state,
    history: [
      {
        message: { role: "user" as const, content: "hi", id: "u1" },
        contextItems: [],
      },
      {
        message: { role: "assistant" as const, content: "", id: "a1" },
        contextItems: [],
      },
    ],
    isStreaming: true,
  };
}

describe("streamUpdate x_progress handling", () => {
  it("extracts x_progress into state.xProgress", () => {
    const state = startedState();
    const next = sessionReducer(
      state as any,
      streamUpdate([
        {
          role: "assistant",
          content: "Hello",
          metadata: { x_progress: xProgress },
        } as ChatMessage,
      ]),
    );

    expect(next.xProgress).toEqual(xProgress);
  });

  it("does not mutate the action payload", () => {
    const state = startedState();
    const message = {
      role: "assistant" as const,
      content: "Hello",
      metadata: { x_progress: xProgress },
    } as ChatMessage;
    const payload = [message];

    sessionReducer(state as any, streamUpdate(payload));

    // The caller's object must be untouched: no delete, no reassignment.
    expect((message as any).metadata).toEqual({ x_progress: xProgress });
    expect(payload[0]).toBe(message);
  });

  it("does not persist x_progress onto the stored message", () => {
    const state = startedState();
    const next = sessionReducer(
      state as any,
      streamUpdate([
        {
          role: "assistant",
          content: "Hello",
          metadata: { x_progress: xProgress },
        } as ChatMessage,
      ]),
    );

    const stored = next.history[next.history.length - 1].message as any;
    expect(stored.metadata?.x_progress).toBeUndefined();
    expect(stored.content).toBe("Hello");
  });

  it("preserves other metadata keys while stripping x_progress", () => {
    const state = startedState();
    const next = sessionReducer(
      state as any,
      streamUpdate([
        {
          role: "assistant",
          content: "Hello",
          metadata: { x_progress: xProgress, responsesOutputItemId: "item_1" },
        } as ChatMessage,
      ]),
    );

    const stored = next.history[next.history.length - 1].message as any;
    expect(stored.metadata?.x_progress).toBeUndefined();
    expect(stored.metadata?.responsesOutputItemId).toBe("item_1");
  });

  it("clears xProgress when a new stream starts", () => {
    const state = startedState();
    const streamed = sessionReducer(
      state as any,
      streamUpdate([
        {
          role: "assistant",
          content: "Hello",
          metadata: { x_progress: xProgress },
        } as ChatMessage,
      ]),
    );
    expect(streamed.xProgress).toEqual(xProgress);

    const restarted = sessionReducer(streamed, setActive());
    expect(restarted.xProgress).toBeNull();
  });
});
