import { html, svg } from "lit";
import { strokeIcon } from "../../components/icons-tools.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type { NewSessionVisibility } from "./create-params.ts";

const shredderIcon = strokeIcon(svg` <path
    d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5"
  />
  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
  <path d="M10 22v-5" />
  <path d="M14 19v-2" />
  <path d="M18 20v-3" />
  <path d="M2 13h20" />
  <path d="M6 20v-3" />`);

/** Page-level session privacy control for the fixed new-session rail. */
export function renderNewSessionIncognitoControl(submission: {
  visibility: NewSessionVisibility;
  submitting: boolean;
  pendingPlacement: { sessionKey: string };
  incognitoDisabledReason: () => string | undefined;
  setVisibility: (visibility: NewSessionVisibility) => void;
}) {
  const active = submission.visibility === "incognito";
  const disabledReason = submission.incognitoDisabledReason();
  const disabled =
    submission.submitting ||
    Boolean(submission.pendingPlacement.sessionKey) ||
    Boolean(disabledReason);
  const description = disabledReason ?? t("newSession.incognitoDescription");
  return html`
    <div class="new-session-page__incognito-rail">
      <openclaw-tooltip .content=${description}>
        <button
          type="button"
          class="shell-chrome-controls__button new-session-page__incognito-toggle ${active
            ? "new-session-page__incognito-toggle--active"
            : ""}"
          role="switch"
          aria-label=${t("newSession.incognito")}
          aria-checked=${String(active)}
          ?disabled=${disabled}
          title=${description}
          @click=${() => {
            if (!disabled) {
              submission.setVisibility(active ? "normal" : "incognito");
            }
          }}
        >
          ${shredderIcon}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

/** Persistent context beside the draft while ephemeral session mode is active. */
export function renderNewSessionIncognitoNotice(active: boolean) {
  const description = t("newSession.incognitoDescription");
  return html`
    <div
      class="new-session-page__incognito-notice ${active
        ? "new-session-page__incognito-notice--visible"
        : ""}"
      role="status"
      aria-hidden=${String(!active)}
    >
      <span class="new-session-page__incognito-notice-icon" aria-hidden="true">
        ${shredderIcon}
      </span>
      <span>${description}</span>
    </div>
  `;
}
