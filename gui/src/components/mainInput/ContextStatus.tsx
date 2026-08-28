import { useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { saveCurrentSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

const SIZE = 20;
const CENTER = SIZE / 2;
const STROKE = 2.5;
// Fill the viewBox out to the stroke edge so the meter reads at the same
// visual size as the h-3 w-3 heroicons beside it, which paint their full box.
const RADIUS = (SIZE - STROKE) / 2;

function pointOnCircle(percent: number): [number, number] {
  const angle = (percent / 100) * 2 * Math.PI;
  return [CENTER + RADIUS * Math.sin(angle), CENTER - RADIUS * Math.cos(angle)];
}

/**
 * Describes an arc sweeping clockwise between two points on the circle.
 *
 * Kept in a fixed viewBox so the meter can never overflow its container,
 * regardless of the percentage handed to it.
 */
function describeArc(fromPercent: number, toPercent: number): string {
  const sweep = toPercent - fromPercent;

  // A single arc command cannot express a full circle - its start and end
  // points would coincide - so draw it as two half sweeps.
  if (sweep >= 100) {
    const top = CENTER - RADIUS;
    const bottom = CENTER + RADIUS;
    return `M ${CENTER} ${top} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTER} ${bottom} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTER} ${top}`;
  }

  const [startX, startY] = pointOnCircle(fromPercent);
  const [endX, endY] = pointOnCircle(toPercent);
  const largeArc = sweep > 50 ? 1 : 0;

  return `M ${startX.toFixed(3)} ${startY.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)}`;
}

/**
 * Ramps blue-green -> yellow -> screaming red as the context fills.
 *
 * Saturation and lightness climb toward the top of the range so a nearly-full
 * context reads as an alarm rather than just another hue.
 */
function usageColor(percent: number): string {
  const t = percent / 100;
  const hue = 170 * (1 - t) ** 1.5;
  const saturation = 70 + 30 * t;
  const lightness = 45 + 10 * t ** 2;
  // Comma-separated form: VS Code webviews can run on older Chromium where the
  // space-separated syntax fails to parse and the stroke silently loses color.
  return `hsl(${hue.toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%)`;
}

const ContextStatus = () => {
  const dispatch = useAppDispatch();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const selectedChatModel = useAppSelector(
    (state) => state.config.config.selectedModelByRole.chat?.model,
  );
  const previousHistoryLength = useRef<number | null>(null);
  const previousSelectedChatModel = useRef<string | null>(null);
  const history = useAppSelector((state) => state.session.history);
  const isPruned = useAppSelector((state) => state.session.isPruned);

  // Clamped defensively: contextPercentage is a raw ratio and has been
  // observed above 1 when fixed system/tool overhead exceeds the window.
  const percent = Math.min(
    Math.max(Math.round((contextPercentage ?? 0) * 100), 0),
    100,
  );
  const remaining = 100 - percent;

  const isDifferentModelAndSameHistory = useMemo(() => {
    if (!selectedChatModel) return false;
    // only reset if history changes
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  const compactConversation = useCompactConversation();

  // if user changed to a different model, we shouldn't show the context status until the user sends a new message
  if (isDifferentModelAndSameHistory) {
    return null;
  }

  return (
    <ToolTip
      closeEvents={{
        mouseleave: true,
        click: true,
        mouseup: false,
      }}
      clickable
      content={
        <div className="flex flex-col gap-0 text-left text-xs">
          <span className="inline-block">
            {`${remaining}% of context remaining.`}
          </span>
          {isPruned && (
            <span className="inline-block">
              {`Oldest messages are being removed.`}
            </span>
          )}
          {history.length > 0 && (
            <div className="flex flex-col gap-1 whitespace-pre">
              <div>
                <span
                  className="hover:text-link inline-block cursor-pointer underline"
                  onClick={() => compactConversation(history.length - 1)}
                >
                  Compact conversation
                </span>
                {"\n"}
                <span
                  className="hover:text-link inline-block cursor-pointer underline"
                  onClick={() => {
                    void dispatch(
                      saveCurrentSession({
                        openNewSession: true,
                        generateTitle: false,
                      }),
                    );
                  }}
                >
                  Start a new session
                </span>
              </div>
            </div>
          )}
        </div>
      }
    >
      {/* Sized by class, not by width/height attributes, so it matches the
          h-3 w-3 heroicons sharing this row (AtSymbolIcon, PhotoIcon). Fixed
          attributes sat outside Tailwind's sizing and left the meter visibly
          off against its neighbours. */}
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-3 w-3 shrink-0"
        role="img"
        aria-label={`${remaining}% of context remaining`}
      >
        {/* Unfilled track: a full ring, always drawn.

            This started as a complementary arc from `percent` to 100, which is
            geometrically equivalent - the used arc covers the rest of the
            ring. It was replaced because that arc was hardcoded `#1a1a1a` at
            0.85 opacity and proved invisible against a dark theme, not because
            of its geometry. The ring inherits `currentColor` instead, so it
            follows the theme like the icons beside it.

            Keeping it as a full circle also gives a stable outline at every
            percentage: at 0% the used arc is not rendered at all, so the ring
            is the only thing drawn, and an empty context still reads as a
            meter rather than as nothing. Any change back to an arc needs to
            stay visible at 0% and 100%, and must not reintroduce a fixed
            colour. */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeWidth={STROKE}
        />
        {/* Used context: blue-green through red, clockwise from 12 o'clock.
            Butt caps - round ones add a half-stroke blob at each end, which
            at low percentages is several times longer than the arc itself. */}
        {percent > 0 && (
          <path
            d={describeArc(0, percent)}
            stroke={usageColor(percent)}
            strokeWidth={STROKE}
            strokeLinecap="butt"
          />
        )}
      </svg>
    </ToolTip>
  );
};

export default ContextStatus;
