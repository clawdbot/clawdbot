import { html } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type { NewSessionVisibility } from "./create-params.ts";

/** Page-level session privacy control for the fixed new-session rail. */
export function renderNewSessionIncognitoControl(submission: {
  visibility: NewSessionVisibility;
  submitting: boolean;
  pendingCloud: { sessionKey: string };
  incognitoDisabledReason: () => string | undefined;
  setVisibility: (visibility: NewSessionVisibility) => void;
}) {
  const active = submission.visibility === "incognito";
  const disabledReason = submission.incognitoDisabledReason();
  const disabled =
    submission.submitting || Boolean(submission.pendingCloud.sessionKey) || Boolean(disabledReason);
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
          ${icons.eyeOff}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}
