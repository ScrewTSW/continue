import { ChatMessage } from "../index.js";
import {
  __resetTokenCountCacheForTests,
  getTokenCountCacheKeysForTests,
  getTokenCountCacheStats,
  withCachedMessageTokens,
} from "./tokenCountCache.js";

describe("tokenCountCache", () => {
  beforeEach(() => {
    __resetTokenCountCacheForTests();
  });

  const msg = (content: string): ChatMessage =>
    ({ role: "user", content }) as ChatMessage;

  it("computes on first call and serves the second from cache", () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return 42;
    };

    expect(withCachedMessageTokens("m", msg("hello"), compute)).toBe(42);
    expect(calls).toBe(1);

    expect(withCachedMessageTokens("m", msg("hello"), compute)).toBe(42);
    expect(calls).toBe(1); // still 1 - served from cache

    const stats = getTokenCountCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  // The compiler rebuilds message objects on every call
  // (`msgs.map((m) => ({ ...m }))`), and messages also cross the messenger
  // boundary as JSON. Identity-keyed caching (WeakMap) can therefore never
  // hit; the key must be derived from content.
  it("hits across distinct object instances with equal content", () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return 7;
    };

    withCachedMessageTokens(
      "m",
      { role: "user", content: "abc" } as ChatMessage,
      compute,
    );
    withCachedMessageTokens(
      "m",
      { role: "user", content: "abc" } as ChatMessage,
      compute,
    );

    expect(calls).toBe(1);
  });

  it("does not confuse different content", () => {
    const compute = (n: number) => () => n;

    expect(withCachedMessageTokens("m", msg("aaa"), compute(1))).toBe(1);
    expect(withCachedMessageTokens("m", msg("bbb"), compute(2))).toBe(2);
    expect(withCachedMessageTokens("m", msg("aaa"), compute(99))).toBe(1);
  });

  it("keys on model - the same text tokenizes differently per tokenizer", () => {
    const compute = (n: number) => () => n;

    expect(withCachedMessageTokens("llama", msg("x"), compute(10))).toBe(10);
    expect(withCachedMessageTokens("gpt-4", msg("x"), compute(20))).toBe(20);
    expect(withCachedMessageTokens("llama", msg("x"), compute(99))).toBe(10);
  });

  it("distinguishes messages that differ only by role", () => {
    const compute = (n: number) => () => n;

    const user = { role: "user", content: "same" } as ChatMessage;
    const assistant = { role: "assistant", content: "same" } as ChatMessage;

    expect(withCachedMessageTokens("m", user, compute(1))).toBe(1);
    expect(withCachedMessageTokens("m", assistant, compute(2))).toBe(2);
  });

  it("distinguishes tool calls that differ only in arguments", () => {
    const compute = (n: number) => () => n;

    const call = (args: string) =>
      ({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "1",
            type: "function",
            function: { name: "f", arguments: args },
          },
        ],
      }) as ChatMessage;

    expect(withCachedMessageTokens("m", call('{"a":1}'), compute(1))).toBe(1);
    expect(withCachedMessageTokens("m", call('{"a":2}'), compute(2))).toBe(2);
  });

  // The entry-count cap alone does not bound memory: a key that embeds full
  // message content means 4096 large tool outputs can retain hundreds of MiB
  // (a 1MB message x 4096 is ~4 GiB) long after the conversation is released.
  // Keys are fixed-size digests so worst-case memory is a function of the cap
  // alone, and raw prompt/tool text is not retained by the cache.
  // `stripImages` joins text parts with `.join("\n")`, which renders an absent
  // `text` as "". A key that interpolates `part.text` instead produces
  // "undefined", so a part with no text and a part whose text is literally
  // "undefined" share a key - and one is served the other's count.
  it("separates a text part with absent text from the literal string 'undefined'", () => {
    const part = (text?: string): ChatMessage =>
      ({
        role: "user",
        content: [
          text === undefined ? { type: "text" } : { type: "text", text },
        ],
      }) as unknown as ChatMessage;

    expect(withCachedMessageTokens("m", part(undefined), () => 1)).toBe(1);
    expect(withCachedMessageTokens("m", part("undefined"), () => 2)).toBe(2);

    // And each keeps its own count on the way back out.
    expect(withCachedMessageTokens("m", part(undefined), () => 99)).toBe(1);
    expect(withCachedMessageTokens("m", part("undefined"), () => 99)).toBe(2);
  });

  // Absent text and empty-string text DO normalize together, matching
  // `stripImages` - they tokenize identically, so sharing a key is correct.
  it("treats absent text and empty text as the same message", () => {
    const absent = {
      role: "user",
      content: [{ type: "text" }],
    } as unknown as ChatMessage;
    const empty = {
      role: "user",
      content: [{ type: "text", text: "" }],
    } as unknown as ChatMessage;

    let calls = 0;
    withCachedMessageTokens("m", absent, () => {
      calls++;
      return 5;
    });
    expect(
      withCachedMessageTokens("m", empty, () => {
        calls++;
        return 6;
      }),
    ).toBe(5);
    expect(calls).toBe(1);
  });

  it("stores fixed-size keys regardless of message size", () => {
    const small = msg("x");
    const huge = msg("y".repeat(2 * 1024 * 1024));

    withCachedMessageTokens("m", small, () => 1);
    withCachedMessageTokens("m", huge, () => 2);

    const keys = getTokenCountCacheKeysForTests();
    expect(keys).toHaveLength(2);

    const [a, b] = keys.map((k) => k.length);
    expect(a).toBe(b);
    // Comfortably smaller than either message; a content-embedding key would
    // be megabytes here.
    expect(a).toBeLessThan(512);
  });

  it("does not retain raw message content in its keys", () => {
    const secret = "correct-horse-battery-staple-" + "z".repeat(5000);
    withCachedMessageTokens("m", msg(secret), () => 1);

    for (const key of getTokenCountCacheKeysForTests()) {
      expect(key).not.toContain("correct-horse-battery-staple");
    }
  });

  it("evicts oldest entries past the cap so a long session cannot grow unbounded", () => {
    const cap = getTokenCountCacheStats().maxEntries;

    for (let i = 0; i < cap + 50; i++) {
      withCachedMessageTokens("m", msg(`msg-${i}`), () => i);
    }

    expect(getTokenCountCacheStats().size).toBeLessThanOrEqual(cap);

    // The most recent entries must still be present.
    let calls = 0;
    withCachedMessageTokens("m", msg(`msg-${cap + 49}`), () => {
      calls++;
      return -1;
    });
    expect(calls).toBe(0);
  });
});
