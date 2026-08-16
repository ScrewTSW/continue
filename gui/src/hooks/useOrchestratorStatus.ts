import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../redux/hooks";
import { selectSelectedChatModel } from "../redux/slices/configSlice";

export type OrchestratorModel = {
  alias: string;
  alive: boolean;
  loading: boolean;
  ctx_size: number;
  idle_seconds: number;
  idle_timeout: number;
  unload_in: number;
  active_requests: number;
  is_hybrid: boolean;
  n_slots: number;
  last_prompt_tokens: number;
  last_completion_tokens: number;
};

export type OrchestratorStatus = {
  /** False when no orchestrator is configured, or it is unreachable. */
  available: boolean;
  /** True once a probe has completed, so callers can stay silent until then. */
  probed: boolean;
  maxLoaded: number | null;
  loaded: OrchestratorModel[];
};

const EMPTY: OrchestratorStatus = {
  available: false,
  probed: false,
  maxLoaded: null,
  loaded: [],
};

/**
 * Derive the orchestrator root from an OpenAI-compatible apiBase
 * (e.g. http://192.168.1.2:58108/v1 -> http://192.168.1.2:58108).
 */
export function resolveOrchestratorURL(
  apiBase: string | undefined,
): string | null {
  if (!apiBase) return null;
  try {
    const url = new URL(apiBase);
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/v1")) {
      return `${url.origin}${path.replace(/\/v1$/, "")}`;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Polls /orchestrator/status for the selected chat model's apiBase.
 *
 * This is deliberately additive to the SSE x_progress stream: the poll is the
 * authoritative source for coarse state (loading / generating / idle) and for
 * residency facts the stream cannot carry (unload countdown, slots), while
 * x_progress remains the only source of live token/throughput/GPU numbers.
 *
 * Polls faster while a request is in flight, pauses when the document is
 * hidden, and goes quiet after repeated failures so non-orchestrator
 * endpoints (cloud providers, plain llama-server) cost nothing.
 */
export function useOrchestratorStatus(active: boolean = false) {
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const root = resolveOrchestratorURL(selectedModel?.apiBase);

  const [status, setStatus] = useState<OrchestratorStatus>(EMPTY);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const failures = useRef(0);

  useEffect(() => {
    cancelled.current = false;
    failures.current = 0;

    if (!root) {
      setStatus(EMPTY);
      return;
    }

    const poll = async () => {
      if (cancelled.current) return;

      if (typeof document !== "undefined" && document.hidden) {
        timeoutRef.current = setTimeout(poll, 5000);
        return;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${root}/orchestrator/status`, {
          signal: controller.signal,
          cache: "no-store",
        });
        clearTimeout(timer);

        if (!res.ok) throw new Error(`http-${res.status}`);

        const data = await res.json();
        failures.current = 0;
        if (!cancelled.current) {
          setStatus({
            available: true,
            probed: true,
            maxLoaded: data.max_loaded ?? null,
            loaded: (data.loaded_models ?? []) as OrchestratorModel[],
          });
        }
      } catch {
        failures.current += 1;
        if (!cancelled.current) {
          setStatus({ ...EMPTY, probed: true });
        }
      }

      if (cancelled.current) return;

      // Back off hard once it's clear this isn't an orchestrator.
      if (failures.current >= 3) {
        timeoutRef.current = setTimeout(poll, 60000);
        return;
      }

      timeoutRef.current = setTimeout(poll, active ? 1500 : 5000);
    };

    void poll();

    return () => {
      cancelled.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [root, active]);

  return status;
}
