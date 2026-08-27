import type { XProgress } from "core";
import { describe, expect, it } from "vitest";
import { derivePhaseLabel } from "./StreamingToolbar";

/**
 * The three payload shapes the orchestrator actually emits, mirrored from
 * router.py. They are deliberately separate builders rather than one generic
 * one: the emitters carry *different* fields, and that difference is the whole
 * point of the phase logic.
 *
 * Verified against a live stream from the 3090 orchestrator, e.g.
 *   {"gen":1,"think":0,"prompt":9,"elapsed":0.2,"tok_s":0,
 *    "ctx_size":288768,"ctx_used":10,"vram_used":13327,...}
 */

/** keepalive_loop - cold model load. Carries `loading`, never `state`. */
function loadingFrame(elapsed = 0): XProgress {
  return {
    gen: 0,
    think: 0,
    prompt: 0,
    elapsed,
    tok_s: 0,
    ctx_size: 288768,
    ctx_used: 0,
    loading: true,
  };
}

/**
 * prompt_eval_loop - carries `state` and `prompt_total`, never `loading`.
 * `state` flips to "generating" once the slot reports n_decoded > 0, so this
 * builder covers both eval and the handoff.
 */
function evalFrame(
  promptDone: number,
  promptTotal: number,
  state: "prompt eval" | "generating" = "prompt eval",
): XProgress {
  return {
    gen: 0,
    think: 0,
    prompt: promptDone,
    prompt_total: promptTotal,
    elapsed: 0,
    tok_s: 0,
    ctx_size: 288768,
    ctx_used: promptDone || promptTotal,
    state,
  };
}

/**
 * The streaming proxy path - the payload attached to real content chunks.
 *
 * Note it carries NO `state` and NO `loading`: generation is signalled only by
 * `gen` climbing. Any logic that waits for state === "generating" here would
 * never fire.
 */
function streamFrame(gen: number, tokS = 0): XProgress {
  return {
    gen,
    think: 0,
    prompt: 9,
    elapsed: 0.2,
    tok_s: tokS,
    ctx_size: 288768,
    ctx_used: 9 + gen,
  };
}

describe("derivePhaseLabel", () => {
  describe('"Generating" is only claimed when the model is really generating', () => {
    // The bug this guards: the toolbar rendered a hard-coded "Generating" for
    // the whole request, so a cold VRAM load and prompt evaluation both
    // reported generation while zero tokens existed.

    it("does not claim generation while the model is loading into VRAM", () => {
      expect(derivePhaseLabel(loadingFrame())).not.toBe("Generating");
    });

    it("does not claim generation during prompt eval", () => {
      expect(derivePhaseLabel(evalFrame(5000, 12800))).not.toBe("Generating");
    });

    it("does not claim generation before any progress is reported", () => {
      expect(derivePhaseLabel(undefined)).not.toBe("Generating");
      expect(derivePhaseLabel(null)).not.toBe("Generating");
    });

    it("does not claim generation on a stream frame with no tokens yet", () => {
      // The proxy attaches x_progress to the priming chunk too, before any
      // token has been decoded.
      expect(derivePhaseLabel(streamFrame(0))).not.toBe("Generating");
    });

    it("claims generation on real stream frames, which carry no state field", () => {
      // This is the live shape: generation is signalled by `gen` alone.
      expect(derivePhaseLabel(streamFrame(1))).toBe("Generating");
      expect(derivePhaseLabel(streamFrame(70, 30.7))).toBe("Generating");
    });

    it("claims generation when prompt_eval_loop reports the handoff", () => {
      // prompt_eval_loop is the only emitter that ever sets state=generating,
      // which it does once the slot reports n_decoded > 0.
      expect(derivePhaseLabel(evalFrame(9, 9, "generating"))).toBe(
        "Generating",
      );
    });
  });

  describe("phase labels", () => {
    it("reports a cold model load", () => {
      expect(derivePhaseLabel(loadingFrame(23.2))).toBe("Loading model");
    });

    it("reports prompt evaluation", () => {
      expect(derivePhaseLabel(evalFrame(0, 12800))).toBe("Reading prompt");
    });

    it("falls back to a neutral verb with no phase information", () => {
      expect(derivePhaseLabel(undefined)).toBe("Working");
    });

    it("prefers loading over state if both ever arrive together", () => {
      // The two loops are mutually exclusive in router.py today; this pins the
      // precedence so a future overlap at the handoff cannot regress it.
      expect(
        derivePhaseLabel({ ...loadingFrame(), state: "prompt eval" }),
      ).toBe("Loading model");
    });

    it("prefers an explicit eval state over a stale token count", () => {
      expect(derivePhaseLabel({ ...evalFrame(4000, 12800), gen: 40 })).toBe(
        "Reading prompt",
      );
    });
  });

  /**
   * Before any request is sent, the GUI blocks on `llm/compileChat`, which
   * tokenizes the whole conversation on the extension host. For a long session
   * that is seconds of dead air during which no `x_progress` can exist, because
   * no request has been made yet. Reporting "Working" there was indistinguishable
   * from a stalled stream.
   */
  describe("pre-flight tokenization", () => {
    it("reports tokenization while the pre-flight compile is running", () => {
      expect(derivePhaseLabel(undefined, true)).toBe("Tokenizing");
    });

    it("outranks the neutral fallback, which cannot distinguish this case", () => {
      expect(derivePhaseLabel(null, true)).toBe("Tokenizing");
    });

    it("stops claiming tokenization once the compile finishes", () => {
      expect(derivePhaseLabel(undefined, false)).toBe("Working");
    });

    it("never masks a real phase from the wire", () => {
      // If frames somehow arrive while the flag is still set, the wire wins:
      // it is direct evidence, the flag is only an inference.
      expect(derivePhaseLabel(loadingFrame(2), true)).toBe("Loading model");
      expect(derivePhaseLabel(evalFrame(0, 12800), true)).toBe(
        "Reading prompt",
      );
      expect(derivePhaseLabel(streamFrame(5), true)).toBe("Generating");
    });

    it("defaults to not tokenizing when the flag is omitted", () => {
      // Keeps every existing call site behaving exactly as before.
      expect(derivePhaseLabel(undefined)).toBe("Working");
    });
  });

  describe("the full request lifecycle", () => {
    it("moves load -> read -> generate without claiming generation early", () => {
      // A cold-start request as the orchestrator actually emits it: keepalive
      // frames, then prompt_eval frames, then streaming frames.
      const timeline: XProgress[] = [
        loadingFrame(2.0),
        loadingFrame(23.2),
        evalFrame(0, 12800),
        evalFrame(8000, 12800),
        streamFrame(1),
        streamFrame(70, 30.7),
      ];

      // Called explicitly rather than point-free: `map` passes the index as the
      // second argument, which would land in `isTokenizing`.
      expect(timeline.map((frame) => derivePhaseLabel(frame))).toEqual([
        "Loading model",
        "Loading model",
        "Reading prompt",
        "Reading prompt",
        "Generating",
        "Generating",
      ]);
    });

    it("never says Generating before the first token in a cold-start stream", () => {
      const beforeFirstToken: XProgress[] = [
        loadingFrame(),
        loadingFrame(23.2),
        evalFrame(4000, 12800),
        streamFrame(0),
      ];

      for (const frame of beforeFirstToken) {
        expect(derivePhaseLabel(frame)).not.toBe("Generating");
      }
    });
  });
});
