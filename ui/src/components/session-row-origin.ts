import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

/**
 * Where a session came from, rendered as ordinary content ahead of the title.
 * Absent origin renders nothing at all, so a row with no creator and no
 * privacy qualifier starts its title on the same axis as its section label.
 */
export function renderSessionRowOrigin(params: {
  actor: SessionCreatedActor | null | undefined;
  attribution: "created" | "archived";
  draft: boolean;
  incognito: boolean;
}): TemplateResult | typeof nothing {
  const actor = params.actor?.id?.trim() ? params.actor : undefined;
  if (!actor && !params.draft && !params.incognito) {
    return nothing;
  }
  return html`<span class="session-row-origin">
    ${actor ? renderSessionOwnerChip(actor, "row", params.attribution) : nothing}
    ${params.incognito
      ? html`<span
          class="session-row-origin__qualifier"
          role="img"
          aria-label=${t("sessionsView.incognito")}
          title=${t("sessionsView.incognito")}
          >${icons.hatGlasses}</span
        >`
      : nothing}
    ${params.draft
      ? html`<span class="session-row-origin__draft">${t("chat.sessionSharing.draft")}</span>`
      : nothing}
  </span>`;
}
