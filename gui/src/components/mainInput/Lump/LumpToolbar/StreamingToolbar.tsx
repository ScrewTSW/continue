import { useAppSelector } from "../../../../redux/hooks";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { GeneratingIndicator } from "./GeneratingIndicator";

export function ProgressLabels() {
  const xProgress = useAppSelector((state) => state.session.xProgress);
  if (!xProgress) return null;

  const parts: string[] = [];
  const p = xProgress as any;

  if (p.elapsed > 0) {
    parts.push(`${p.elapsed.toFixed(1)}s`);
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
    if (p.think > 0) {
      parts.push(`${p.think} think`);
    }
    if (p.gen > 0) {
      parts.push(`${p.gen} gen`);
    }
    if (p.tok_s > 0) {
      parts.push(`${p.tok_s.toFixed(1)} tok/s`);
    }
  }
  if (p.ctx_size > 0) {
    const pct = ((p.ctx_used / p.ctx_size) * 100).toFixed(0);
    const usedK = (p.ctx_used / 1024).toFixed(1);
    const totalK = (p.ctx_size / 1024).toFixed(0);
    parts.push(`${usedK}k/${totalK}k ctx (${pct}%)`);
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
  if (p.gpu_util != null && p.gpu_temp) {
    parts.push(`GPU ${p.gpu_util}% ${p.gpu_temp}°C`);
  } else if (p.gpu_temp) {
    parts.push(`${p.gpu_temp}°C`);
  }

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
