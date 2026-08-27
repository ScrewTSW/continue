import { createHash } from "crypto";

import { ChatMessage } from "../index.js";

/**
 * Memoises per-message token counts across `compileChatMessages` calls.
 *
 * Why this exists: the chat tokenizer for non-GPT models is a pure-JS BPE
 * (`llamaTokenizer`) running synchronously on the extension host, and nothing
 * cached its results. Every request re-tokenised the entire conversation from
 * scratch, so turn N paid for all N-1 previous turns again. Measured at ctx
 * 288768, a 20-turn session with 128KB tool outputs spent ~4.5s in
 * `compileChatMessages` before a single byte reached the model - the host was
 * blocked the whole time, which VS Code reports as an unresponsive extension.
 *
 * Keyed on content rather than object identity: `compileChatMessages` rebuilds
 * every message (`msgs.map((m) => ({ ...m }))`) and messages cross the
 * messenger boundary as JSON, so a `WeakMap` keyed on the object would never
 * hit. Token counts are a pure function of (model, message), so a content key
 * is exact - not an approximation.
 */

// Keys are fixed-size digests, so this entry cap really does bound worst-case
// memory. That is the reason for hashing: an earlier version embedded message
// content in the key, where 4096 entries of large tool outputs could retain
// gigabytes long after the conversation itself was released.
const MAX_ENTRIES = 4096;

const cache = new Map<string, number>();
let hits = 0;
let misses = 0;

/**
 * Builds the cache key: a SHA-256 digest over the fields that affect the count.
 *
 * Hashing keeps keys fixed-size, which is what makes the entry cap a real
 * memory bound, and avoids retaining raw prompt or tool-output text in a
 * long-lived map. The digest is cheap relative to the work being cached -
 * ~0.66ms for 1MB versus ~3187ms to tokenize the same text - so it does not
 * erode the win.
 *
 * SHA-256 collisions are not a practical concern at this cache size, and a
 * collision would only mis-count tokens, not corrupt output.
 *
 * Only the fields `countChatMessageTokens` actually counts are included.
 */
function cacheKey(modelName: string, message: ChatMessage): string {
  const parts: string[] = [modelName, message.role];

  const content = message.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    // Image parts contribute a flat token count, so their presence matters but
    // their payload does not - avoid keying on base64 blobs.
    for (const part of content) {
      parts.push(part.type === "text" ? `t:${part.text}` : `i:${part.type}`);
    }
  }

  if ("toolCalls" in message && message.toolCalls) {
    for (const call of message.toolCalls) {
      parts.push(JSON.stringify(call));
    }
  }

  if (message.role === "thinking") {
    if (message.redactedThinking) parts.push(message.redactedThinking);
    if (message.signature) parts.push(message.signature);
  }

  if (message.role === "tool" && message.toolCallId) {
    parts.push(message.toolCallId);
  }

  // Length-prefix each part before hashing: any delimiter can also occur
  // inside message content, which would let one message forge another's key
  // and return a wrong token count.
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${part.length}:`);
    hash.update(part);
  }
  return hash.digest("base64");
}

/**
 * Returns the cached token count for `message`, or computes and stores it.
 *
 * `compute` must be a pure function of the same (modelName, message) pair.
 */
export function withCachedMessageTokens(
  modelName: string,
  message: ChatMessage,
  compute: () => number,
): number {
  const key = cacheKey(modelName, message);

  const cached = cache.get(key);
  if (cached !== undefined) {
    hits++;
    // Refresh recency: re-inserting moves the key to the end of Map iteration
    // order, so eviction below drops genuinely cold entries rather than merely
    // old ones.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  misses++;
  const value = compute();
  cache.set(key, value);

  if (cache.size > MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the least recently
    // used. Evict in a loop: a single delete is not enough if the cap is
    // lowered or several entries are added before the next check.
    for (const oldest of cache.keys()) {
      cache.delete(oldest);
      if (cache.size <= MAX_ENTRIES) break;
    }
  }

  return value;
}

export function getTokenCountCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  maxEntries: number;
} {
  return { size: cache.size, hits, misses, maxEntries: MAX_ENTRIES };
}

export function getTokenCountCacheKeysForTests(): string[] {
  return [...cache.keys()];
}

export function __resetTokenCountCacheForTests(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
