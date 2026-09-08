import { html } from "lit";
import "../styles/capacity-meter.css";

type CapacityMeterOptions = {
  label: string;
  tone: "ok" | "stale" | "warn" | "danger" | "accent";
} & (
  | { mode: "continuous"; percent: number }
  | { mode: "discrete"; total: number; used: number | null }
);

/** Shared sessions micro-meter; integer capacities use pips up to twelve slots. */
export function renderCapacityMeter(options: CapacityMeterOptions) {
  if (options.mode === "discrete" && options.total <= 12) {
    return html`<span
      class="capacity-meter-pips session-context-meter--${options.tone}"
      role="img"
      aria-label=${options.label}
    >
      ${Array.from(
        { length: options.total },
        (_, index) => html`
          <span
            class="capacity-meter-pips__pip ${
              options.used !== null && index < options.used
                ? "capacity-meter-pips__pip--filled"
                : ""
            }"
          ></span>
        `,
      )}
    </span>`;
  }
  const percent =
    options.mode === "continuous"
      ? options.percent
      : options.used === null
        ? 0
        : (options.used / options.total) * 100;
  return html`<span
    class="session-context-meter session-context-meter--${options.tone}"
    role="img"
    aria-label=${options.label}
  >
    <span class="session-context-meter__fill" style=${`width: ${percent}%`}></span>
  </span>`;
}
