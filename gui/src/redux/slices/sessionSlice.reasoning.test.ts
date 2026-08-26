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
