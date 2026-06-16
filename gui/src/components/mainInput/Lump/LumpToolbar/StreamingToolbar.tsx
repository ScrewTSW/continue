import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../../../redux/hooks";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { GeneratingIndicator } from "./GeneratingIndicator";

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

export function StreamingToolbar({
  onStop,
  displayText = "Stop",
}: StreamingToolbarProps) {
  const jetbrains = isJetBrains();

  return (
    <div className="flex w-full items-center justify-between">
      <div className="flex items-center">
        <GeneratingIndicator />
        <ProgressLabels />
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
