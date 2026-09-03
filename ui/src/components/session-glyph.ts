import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";

type SessionGlyphContent = TemplateResult | typeof nothing;

/**
 * Persistent artwork in the sidebar's leading slot (owner avatar, page icon,
 * attention glyph). Callers can carry run state as a ring when that surface
 * owns activity in the leading slot. Circular content already fits the ring;
 * arbitrary square icons and thumbnails scale down so their corners stay
 * inside it.
 */
export function renderSessionGlyph(options: {
  content: SessionGlyphContent;
  running: boolean;
  queued?: boolean;
  circular?: boolean;
  badge?: SessionGlyphContent;
}): TemplateResult {
  const { content, running, queued = false, circular = false, badge = nothing } = options;
  const modifiers = `${circular ? " session-glyph--circular" : ""}${running ? " session-glyph--running" : ""}`;
  return html`<span class="session-glyph${modifiers}">
    <span class="session-glyph__content">${content}</span>
    ${running
      ? html`<span
          class="session-glyph__ring${queued ? " session-glyph__ring--queued" : ""}"
          role="img"
          aria-label=${t(queued ? "sessionsView.statusQueued" : "sessionsView.activeRun")}
        ></span>`
      : nothing}
    ${badge}
  </span>`;
}

export function renderSessionUnreadBadge(): TemplateResult {
  return html`<span
    class="session-glyph__badge session-glyph__badge--unread"
    role="img"
    aria-label=${t("sessionsView.unread")}
  ></span>`;
}
