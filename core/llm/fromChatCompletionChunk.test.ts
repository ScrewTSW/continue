import { fromChatCompletionChunk } from "./openaiTypeConverters";

/**
 * Chunk shapes here are copied verbatim from a live llama.cpp
 * `/v1/chat/completions` stream started with:
 *
 *   --jinja --reasoning-format deepseek-legacy
 *   --chat-template-file <template with no <think> prefill>
 *
 * Under that configuration reasoning arrives in `reasoning_content` and no
 * `content` delta is ever emitted for a tool-calling turn.
 */
describe("fromChatCompletionChunk", () => {
  it("converts reasoning_content into a thinking message", () => {
    const result = fromChatCompletionChunk({
      choices: [
        {
          finish_reason: null,
          index: 0,
          delta: { reasoning_content: "The user wants" },
        },
      ],
    } as any);

    expect(result).toEqual({
      role: "thinking",
      content: "The user wants",
      signature: undefined,
      reasoning_details: undefined,
    });
  });

  it("falls back to the `reasoning` field name", () => {
    const result = fromChatCompletionChunk({
      choices: [{ finish_reason: null, index: 0, delta: { reasoning: "Hmm" } }],
    } as any);

    expect(result?.role).toBe("thinking");
    expect(result?.content).toBe("Hmm");
  });

  it("emits nothing for a null-content priming chunk", () => {
    // llama.cpp opens every stream with this and it carries no text. Every
    // call site guards with `if (chunk)` and skips, so undefined is the
    // contract for "nothing to emit" - not a dropped message.
    const result = fromChatCompletionChunk({
      choices: [
        {
          finish_reason: null,
          index: 0,
          delta: { role: "assistant", content: null },
        },
      ],
    } as any);

    expect(result).toBeUndefined();
  });

  it("converts tool_calls without losing them to the content branch", () => {
    const result = fromChatCompletionChunk({
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
    } as any);

    expect(result?.role).toBe("assistant");
    expect((result as any).toolCalls).toHaveLength(1);
    expect((result as any).toolCalls[0].function.name).toBe(
      "run_terminal_command",
    );
  });

  it("prefers content when a chunk carries both content and reasoning", () => {
    // Ordering guard: `content` is checked before `reasoning_content`, so a
    // chunk carrying both must not be misclassified as reasoning.
    const result = fromChatCompletionChunk({
      choices: [
        {
          finish_reason: null,
          index: 0,
          delta: { content: "Answer", reasoning_content: "thought" },
        },
      ],
    } as any);

    expect(result?.role).toBe("assistant");
    expect(result?.content).toBe("Answer");
  });

  it("returns undefined for a terminal chunk with an empty delta", () => {
    const result = fromChatCompletionChunk({
      choices: [{ finish_reason: "tool_calls", index: 0, delta: {} }],
    } as any);

    expect(result).toBeUndefined();
  });
});
