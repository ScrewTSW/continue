import type { XProgress } from "core";
import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../../../redux/hooks";
import {
  useOrchestratorStatus,
  type OrchestratorModel,
} from "../../../../hooks/useOrchestratorStatus";
import { selectSelectedChatModel } from "../../../../redux/slices/configSlice";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { GeneratingIndicator } from "./GeneratingIndicator";

const formatCountdown = (secs: number) => {
  if (secs <= 0) return "0s";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

type ModelState = {
  label: string;
  className: string;
};

/**
 * Coarse model state, derived from the orchestrator status poll.
 *
 * The poll is authoritative here in a way the SSE stream cannot be: it still
 * reports correctly while idle, between requests, and when the model was
 * unloaded out from under us. First match wins.
 *
 * Returns null when there is no orchestrator to report on, so that
 * non-orchestrator endpoints render nothing at all.
 */
export function deriveModelState(
  probed: boolean,
  available: boolean,
  model: OrchestratorModel | undefined,
  aliasKnown: boolean,
  isStreaming: boolean,
): ModelState | null {
  if (!probed) return null;

  if (!available) {
    // Only meaningful once we know this endpoint really is an orchestrator.
    return null;
  }

  if (!model) {
    // Distinguish "nothing loaded" from "this model isn't the loaded one",
    // which the alias match would otherwise collapse together.
    return aliasKnown
      ? { label: "Not loaded", className: "text-description-muted" }
      : {
          label: "Model not on orchestrator",
          className: "text-description-muted",
        };
  }

  if (model.loading || (!model.alive && isStreaming)) {
    return {
      label: "Loading into VRAM",
      className: "animate-pulse text-warning",
    };
  }

  if (model.active_requests > 0) {
    return { label: "Generating", className: "animate-pulse text-accent" };
  }

  return { label: "Loaded", className: "text-success" };
}

export function ModelStateLabel() {
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const status = useOrchestratorStatus(isStreaming);

  const model = status.loaded.find((m) => m.alias === selectedModel?.model);
  const aliasKnown = status.loaded.length === 0;
  const state = deriveModelState(
    status.probed,
    status.available,
    model,
    aliasKnown,
    isStreaming,
  );

  if (!state) return null;

  const showCountdown =
    model && model.active_requests === 0 && model.alive && model.unload_in > 0;

  return (
    <span className="text-description ml-2 flex items-center gap-1.5 text-xs opacity-70">
      <span className={state.className}>{state.label}</span>
      {model?.is_hybrid && <span className="text-warning">hybrid</span>}
      {showCountdown && (
        <span>unloads in {formatCountdown(model.unload_in)}</span>
      )}
    </span>
  );
}

export function ProgressLabels() {
  const xProgress = useAppSelector((state) => state.session.xProgress);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (isStreaming && !startRef.current) {
      startRef.current = Date.now();
    } else if (!isStreaming && !xProgress) {
      startRef.current = null;
      setElapsed(0);
    }
  }, [isStreaming, xProgress]);

  useEffect(() => {
    if (!startRef.current || !isStreaming) return;
    const tick = () => setElapsed((Date.now() - startRef.current!) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isStreaming]);

  if (!xProgress && elapsed <= 0) return null;

  const parts: string[] = [];
  // Still `any`: the hardware fields below (vram_*, ram_*, gpu_*, cpu_*,
  // cached) are orchestrator extensions not yet on XProgress. The phase
  // fields it reads - loading/state/prompt_total - are typed now.
  const p = (xProgress as any) || {};

  if (elapsed > 0) {
    parts.push(`${elapsed.toFixed(1)}s`);
  }
  if (p.loading) {
    parts.push("loading model");
  } else if (p.state === "prompt eval") {
    const total = p.prompt_total || p.prompt || 0;
    if (total > 0) {
      parts.push(`prompt eval (~${total} tokens)`);
    } else {
      parts.push("prompt eval");
    }
  } else {
    if (p.gen > 0) {
      parts.push(`${p.gen} tokens`);
    }
    if (p.tok_s > 0) {
      parts.push(`${p.tok_s.toFixed(1)} tok/s`);
    }
  }
  if (p.ctx_size > 0) {
    const pct = ((p.ctx_used / p.ctx_size) * 100).toFixed(0);
    const usedK = (p.ctx_used / 1024).toFixed(1);
    const totalK = (p.ctx_size / 1024).toFixed(0);
    let ctxLabel = `${usedK}k/${totalK}k ctx (${pct}%)`;
    if (p.cached > 0) {
      ctxLabel += ` ${p.cached} cached`;
    }
    parts.push(ctxLabel);
  }
  if (p.vram_used && p.vram_total) {
    parts.push(
      `${(p.vram_used / 1024).toFixed(1)}/${(p.vram_total / 1024).toFixed(0)}G VRAM`,
    );
  }
  if (p.ram_used && p.ram_total) {
    parts.push(
      `${(p.ram_used / 1024).toFixed(1)}/${(p.ram_total / 1024).toFixed(0)}G RAM`,
    );
  }
  const hw: string[] = [];
  if (p.gpu_util != null) hw.push(`GPU ${p.gpu_util}%`);
  if (p.gpu_temp) hw.push(`${p.gpu_temp}°C`);
  if (p.cpu_util != null) hw.push(`CPU ${p.cpu_util}%`);
  if (p.cpu_temp) hw.push(`${p.cpu_temp}°C`);
  if (hw.length > 0) parts.push(hw.join(" "));

  if (parts.length === 0) return null;

  return (
    <span className="text-description ml-2 text-xs opacity-70">
      {parts.join(" · ")}
    </span>
  );
}

interface StreamingToolbarProps {
  onStop: () => void;
  displayText?: string;
}

/**
 * The headline verb for the current phase.
 *
 * "Generating" has to be earned: the orchestrator reports a cold model load and
 * prompt evaluation before any token exists, and claiming generation through
 * those phases is what made the old hard-coded label wrong. Order matters -
 * `loading` outranks `state`, because a cold load emits both.
 *
 * When no phase information arrives at all we say "Working" rather than
 * assuming generation. Providers other than the orchestrator send no
 * `x_progress`, and a stream that has produced no tokens yet is not generating.
 * Once tokens appear (`gen > 0`) that is direct evidence, whatever the
 * provider.
 */
export function derivePhaseLabel(
  xProgress: XProgress | null | undefined,
): string {
  if (!xProgress) return "Working";
  if (xProgress.loading) return "Loading model";
  if (xProgress.state === "prompt eval") return "Reading prompt";
  if (xProgress.state === "generating") return "Generating";
  if ((xProgress.gen ?? 0) > 0) return "Generating";
  return "Working";
}

export function StreamingToolbar({
  onStop,
  displayText = "Stop",
}: StreamingToolbarProps) {
  const jetbrains = isJetBrains();
  const xProgress = useAppSelector((state) => state.session.xProgress);
  const phaseLabel = derivePhaseLabel(xProgress);

  return (
    <div className="flex w-full items-center justify-between">
      <div className="flex items-center">
        <GeneratingIndicator text={phaseLabel} />
        <ProgressLabels />
        <ModelStateLabel />
      </div>
      <div
        onClick={onStop}
        className="text-2xs cursor-pointer px-1.5 py-0.5 hover:brightness-125"
      >
        <span className="text-description">{displayText}</span>
        {/* JetBrains overrides cmd+backspace, so we have to use another shortcut */}
        <span className="text-description-muted ml-1 opacity-75">
          {jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}⌫
        </span>
      </div>
    </div>
  );
}
