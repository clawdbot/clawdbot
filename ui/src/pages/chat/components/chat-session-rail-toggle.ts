import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { SessionRailMode } from "./chat-session-rail.ts";

/**
 * Lives apart from chat-session-rail.ts because that module is loaded lazily:
 * the header row must offer the companion before the rail element exists, and a
 * static import of the rail would defeat its dynamic-import boundary.
 *
 * icons.spark is the product's assist glyph. The background-tasks toggle beside
 * this one owns icons.activity and the split-view controls own the panel
 * glyphs, so neither metaphor is available here.
 */
export function renderSessionRailToggle(
  rail: { mode: SessionRailMode; onToggle: () => void } | undefined,
): TemplateResult | typeof nothing {
  if (!rail) {
    return nothing;
  }
  const expanded = rail.mode === "expanded";
  const label = expanded ? t("chat.rail.collapse") : t("chat.rail.show");
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--ghost btn--icon chat-icon-btn chat-session-rail-toggle"
        type="button"
        aria-label=${label}
        aria-expanded=${String(expanded)}
        @click=${rail.onToggle}
      >
        ${icons.spark}
      </button>
    </openclaw-tooltip>
  `;
}
