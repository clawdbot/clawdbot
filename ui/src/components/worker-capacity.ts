import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderCapacityMeter } from "./capacity-meter.ts";
import { icons } from "./icons.ts";

/** Presentation only: the caller owns connectivity and placement eligibility. */
export function workerCapacityPresentation(params: {
  workerSlots?: { available: number; total: number };
  capabilities?: readonly string[];
  commands?: readonly string[];
  unavailable: boolean;
}) {
  const slots = params.workerSlots;
  if (slots) {
    const used = params.unavailable ? null : slots.total - slots.available;
    const label =
      used === null
        ? t("capacityMeter.unavailable")
        : t("capacityMeter.workerSlots", {
            used: String(used),
            total: String(slots.total),
          });
    const tone = params.unavailable ? "stale" : slots.available === 0 ? "warn" : "accent";
    return {
      label,
      // Row titles carry countable facts only; an unavailable node's title
      // belongs to its disabled reason, not the meter's alt text.
      title: used === null ? undefined : label,
      meter: renderCapacityMeter({ mode: "discrete", total: slots.total, used, tone, label }),
    };
  }
  // Environments advertise capabilities/commands together; node inventory keeps them separate.
  const execHost =
    params.capabilities?.some(
      (capability) =>
        capability === "codex.exec-server" || capability === "codex.exec-server.stdio.v1",
    ) || params.commands?.includes("codex.exec-server.stdio.v1");
  if (!execHost) {
    return undefined;
  }
  const label = t("capacityMeter.execHost");
  return {
    label,
    title: label,
    meter: html`<span class="capacity-meter-exec" role="img" aria-label=${label}>
      <span aria-hidden="true">${icons.terminal}</span>${label}
    </span>`,
  };
}
