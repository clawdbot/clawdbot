import { html, nothing } from "lit";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";

export function renderSessionColorDot(value: string | null | undefined) {
  const color = normalizeSessionColorValue(value ?? "");
  return color
    ? html`<span
        class="session-color-dot"
        style=${`--session-color: var(--session-color-${color})`}
        role="img"
        aria-label=${t("sessionsView.sessionColor", { color: t(`sessionsView.colors.${color}`) })}
      ></span>`
    : nothing;
}
