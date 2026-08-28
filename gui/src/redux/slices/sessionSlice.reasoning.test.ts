import { fromChatCompletionChunk } from "core/llm/openaiTypeConverters";
import { describe, expect, it, vi } from "vitest";
import { reasoningElapsedMs } from "../../util/reasoningDuration";
import { ChatHistoryItemWithMessageId, sessionSlice } from "./sessionSlice";

vi.mock("uuid", () => {
  let counter = 0;
  return { v4: () => `uuid-${++counter}` };
});

const createState = () => ({
  lastSessionId: undefined,
  allSessionMetadata: [],
  history: [
    {
      message: { role: "user" as const, content: "list /tmp", id: "user-0" },
      contextItems: [],
    },
  ] as ChatHistoryItemWithMessageId[],
  isStreaming: true,
  title: "Test",
  id: "session",
  streamAborter: new AbortController(),
  symbols: {},
  mode: "agent" as const,
  isInEdit: false,
  codeBlockApplyStates: { states: [], curIndex: 0 },
  newestToolbarPreviewForInput: {},
  isSessionMetadataLoading: false,
  compactionLoading: {},
});

const apply = (state: any, chunks: any[]) => {
  for (const raw of chunks) {
    const message = fromChatCompletionChunk(raw);
    if (message) {
      state = sessionSlice.reducer(state, {
        type: "session/streamUpdate",
        payload: [message],
      });
    }
  }
  return state;
};

/**
 * Chunk shapes below are copied from a live llama.cpp `/v1/chat/completions`
 * stream (`--jinja --reasoning-format deepseek-legacy`, tools attached, chat
 * template without a `<think>` prefill). That configuration emits reasoning in
 * `reasoning_content` and never emits a `content` delta.
 */
describe("streamUpdate: structured reasoning_content", () => {
  it("renders reasoning through the same block as the <think> path", () => {
    let state: any = createState();

    state = apply(state, [
      // Priming chunk: llama.cpp opens every stream with a null-content
      // delta. It must not disturb reasoning accumulation.
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { role: "assistant", content: null },
          },
        ],
      },
      ...["The", " user", " wants", " files"].map((text) => ({
        choices: [
          { finish_reason: null, index: 0, delta: { reasoning_content: text } },
        ],
      })),
    ]);

    const thinking = state.history.filter(
      (item: any) => item.message.role === "thinking",
    );
    expect(thinking).toHaveLength(1);
    // Content is what the thinking block renders.
    expect(thinking[0].message.content).toBe("The user wants files");
    // Mirrored into reasoning so timing/in-progress behave as on the tag path.
    expect(thinking[0].reasoning.text).toBe("The user wants files");
    expect(thinking[0].reasoning.active).toBe(true);
  });

  it("closes the reasoning span when the tool call arrives, recording a duration", () => {
    let state: any = createState();

    state = apply(state, [
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { role: "assistant", content: null },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: "Deciding" },
          },
        ],
      },
      // Reasoning stops with no terminator; the tool call simply follows.
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tc1",
                  type: "function",
                  function: {
                    name: "run_terminal_command",
                    arguments: '{"command":"ls"}',
                  },
                },
              ],
            },
          },
        ],
      },
    ]);

    const thinking = state.history.find(
      (item: any) => item.message.role === "thinking",
    );
    expect(thinking.reasoning.active).toBe(false);
    expect(thinking.reasoning.endAt).toBeDefined();
    // A duration is available even though the thinking item is no longer last,
    // which is the case that previously rendered a timerless block.
    expect(reasoningElapsedMs(thinking)).toBeGreaterThanOrEqual(0);
  });

  it("closes the reasoning span when the user cancels mid-thought", () => {
    let state: any = createState();

    state = apply(state, [
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: "Halfway through" },
          },
        ],
      },
    ]);
    expect(state.history.at(-1).reasoning.active).toBe(true);

    // Cancelling never produces a completion pair, so the span has to be
    // closed here or it stays open for the lifetime of the session.
    state = sessionSlice.reducer(state, { type: "session/setInactive" });

    const thinking = state.history.find(
      (item: any) => item.message.role === "thinking",
    );
    expect(thinking.reasoning.active).toBe(false);
    expect(reasoningElapsedMs(thinking)).toBeGreaterThanOrEqual(0);
  });

  it("closes a reasoning span that is no longer the last item on completion", () => {
    let state: any = createState();

    state = apply(state, [
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: "Deciding" },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tc1",
                  type: "function",
                  function: { name: "ls", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
    ]);

    // Model a stream that ends with the thinking item no longer last: the
    // tool call is `at(-1)`, so a last-item-only close misses the thinking
    // item entirely. Rebuilt rather than mutated because the reducer freezes
    // state.
    const openIndex = state.history.findIndex(
      (item: any) => item.message.role === "thinking",
    );
    state = {
      ...state,
      history: state.history.map((item: any, i: number) =>
        i === openIndex
          ? {
              ...item,
              reasoning: { ...item.reasoning, active: true, endAt: undefined },
            }
          : item,
      ),
    };

    state = sessionSlice.reducer(state, {
      type: "session/addPromptCompletionPair",
      payload: [{ prompt: "p", completion: "c", modelTitle: "m" }],
    });

    expect(state.history[openIndex].reasoning.active).toBe(false);
    expect(reasoningElapsedMs(state.history[openIndex])).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("does not re-parse <think> tags carried inside reasoning_content", () => {
    // A provider can emit literal tags inside the structured field. Feeding a
    // thinking-role message back through the inline tag parser would route it
    // down the assistant path and lose the structured block.
    let state: any = createState();

    state = apply(state, [
      {
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: "<think>weighing options</think>" },
          },
        ],
      },
    ]);

    const thinking = state.history.filter(
      (item: any) => item.message.role === "thinking",
    );
    expect(thinking).toHaveLength(1);
    // Text is preserved verbatim; no assistant item is split out of it.
    expect(thinking[0].message.content).toBe("<think>weighing options</think>");
    expect(
      state.history.some(
        (item: any) =>
          item.message.role === "assistant" && item.message.content?.trim(),
      ),
    ).toBe(false);
  });

  it("closes a span stranded behind a tool result in the same turn", () => {
    // Real agent turn: thinking -> assistant(tool_call) -> tool(result). If the
    // stream ends or is cancelled here, the span from THIS turn sits behind a
    // tool item. Treating `tool` as a hard stop leaves it open forever.
    let state: any = createState();
    state = {
      ...state,
      history: [
        {
          message: { role: "user", content: "list /tmp", id: "u-0" },
          contextItems: [],
        },
        {
          message: { role: "thinking", content: "need ls", id: "t-0" },
          reasoning: { active: true, startAt: 1000, text: "need ls" },
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "", id: "a-0" },
          contextItems: [],
        },
        {
          message: { role: "tool", content: "file-a\nfile-b", id: "tool-0" },
          contextItems: [],
        },
      ],
    };

    state = sessionSlice.reducer(state, { type: "session/setInactive" });

    const thinking = state.history.find(
      (item: any) => item.message.role === "thinking",
    );
    expect(thinking.reasoning.active).toBe(false);
    expect(reasoningElapsedMs(thinking)).toBeGreaterThanOrEqual(0);
  });

  it("never reopens a closed span from an earlier turn", () => {
    // The scan walks back past assistant items to reach a stranded thinking
    // item. It must still stop at the turn boundary rather than walking into
    // a previous turn's already-closed span and restamping its endAt.
    const closed = { active: false, startAt: 10, endAt: 20, text: "old" };
    let state: any = createState();
    state = {
      ...state,
      history: [
        {
          message: { role: "thinking", content: "old", id: "t-old" },
          reasoning: closed,
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "prior answer", id: "a-old" },
          contextItems: [],
        },
        {
          message: { role: "user", content: "next", id: "u-1" },
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "new answer", id: "a-new" },
          contextItems: [],
        },
      ],
    };

    state = sessionSlice.reducer(state, { type: "session/setInactive" });

    expect(state.history[0].reasoning).toEqual(closed);
  });

  it("still records reasoning on the <think> tag path", () => {
    let state: any = createState();

    state = sessionSlice.reducer(state, {
      type: "session/streamUpdate",
      payload: [
        {
          role: "assistant",
          content: "<think>Considering options</think>Here is the answer.",
        },
      ],
    });

    const withReasoning = state.history.find((item: any) => item.reasoning);
    expect(withReasoning.reasoning.text).toBe("Considering options");
    expect(withReasoning.reasoning.active).toBe(false);
    expect(reasoningElapsedMs(withReasoning)).toBeGreaterThanOrEqual(0);
  });
});
