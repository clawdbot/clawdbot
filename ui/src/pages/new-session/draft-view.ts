import { html, nothing, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import { renderChatPermissionPicker } from "../chat/components/chat-permission-picker.ts";
import type { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { renderDraftError } from "./composer.ts";
import { isWorktreeNameValid } from "./create-params.ts";
import { renderNewSessionDraftComposer } from "./draft-composer.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionTitleController } from "./draft-title.ts";
import { renderNewSessionIncognitoNotice } from "./incognito-control.ts";

export function renderNewSessionDraftView(options: {
  context: ApplicationContext | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submission: DraftSubmissionFlow;
  dictation: NewSessionDictationControl;
  titlePreparation: NewSessionTitleController;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  renderTargetBar: () => TemplateResult;
  requestUpdate: () => void;
  onMessage: (message: string) => void;
  onOpenImage: (item: ImageLightboxItem) => void;
}) {
  const {
    context,
    gateway,
    place,
    submission,
    dictation,
    titlePreparation,
    draftOwnerKey,
    isCatalogTarget,
    renderTargetBar,
    requestUpdate,
    onMessage,
    onOpenImage,
  } = options;
  const worktreeNameInvalid = place.worktree && !isWorktreeNameValid(place.worktreeName);
  const capabilities = submission.capabilities;
  const voiceControl = dictation.render(draftOwnerKey);
  const dictationLocked = dictation.active;
  const preparedTitle = titlePreparation.preparedTitle();
  return html`
    <div
      class="new-session-page__draft"
      aria-busy=${String(submission.submitting)}
      @compositionstart=${() => {
        titlePreparation.setComposing(true);
      }}
      @compositionend=${() => {
        titlePreparation.setComposing(false);
      }}
      @focusout=${() => {
        // Browsers can drop compositionend on blur/detach mid-IME; a stuck
        // composing flag would silently disable naming for the mounted page.
        titlePreparation.setComposing(false);
      }}
    >
      ${renderTargetBar()}
      ${worktreeNameInvalid ? renderDraftError(t("newSession.worktreeNameInvalid")) : nothing}
      ${submission.submissionOutcomeUnknown
        ? renderDraftError(
            t(
              submission.submissionOutcomeUnknown === "gateway-changed"
                ? "newSession.createOutcomeUnknown"
                : "newSession.placementSetupInterrupted",
            ),
            submission.pendingPlacement.sessionKey
              ? {
                  label: t("common.reset"),
                  onClick: () => submission.clearPendingPlacementRecovery(),
                }
              : undefined,
          )
        : nothing}
      ${renderNewSessionDraftComposer({
        agent: place.selectedAgent(),
        agentId: place.agentId,
        attachmentDraft: submission.attachmentDraft,
        canSubmit: !submission.submitting && !dictationLocked && submission.canSubmit(),
        submitDisabledReason: submission.submitDisabledReason(),
        blockedSubmitNotice: submission.blockedSubmitNotice(),
        dictationActive: dictation.active,
        dictationPreview: dictation.previewDraft(),
        dictationStatus: dictation.renderStatus(),
        context,
        isCatalogTarget,
        draftOwnerKey,
        message: submission.message,
        visibility: submission.visibility,
        draftAvailable: capabilities.canStartAsDraft(context),
        ...capabilities.composerProps(context, gateway, place.agentId),
        modelControl: place.modelControl,
        permissionControl: isCatalogTarget
          ? undefined
          : renderChatPermissionPicker({
              canSelectFull: place.isAdmin(),
              defaultMode: place.selectedAgent()?.defaultPermissionMode,
              disabled: submission.submitting || Boolean(submission.pendingPlacement.sessionKey),
              disabledReason: submission.submitting ? t("newSession.starting") : undefined,
              mode: submission.permission.value,
              onSelect: (permissionMode) => submission.permission.set(permissionMode ?? undefined),
            }),
        requiresModifier: loadSettings().chatSendShortcut === "modifier-enter",
        requestUpdate,
        submitting: submission.submitting,
        textareaController: submission.composerTextarea,
        voiceControl,
        messageLocked: Boolean(submission.pendingPlacement.sessionKey),
        terminalAction: submission.showStartInTerminal()
          ? {
              canStart:
                !submission.submitting && !dictationLocked && submission.canSubmit("terminal"),
              disabledReason: submission.submitBlock("terminal")?.reason,
              onStart: () => void submission.startInTerminal(),
            }
          : undefined,
        onInput: onMessage,
        onOpenImage,
        onVisibilityChange: (visibility) => {
          if (!submission.submitting && !submission.pendingPlacement.sessionKey) {
            submission.setVisibility(visibility);
          }
        },
        onSubmit: () => void submission.submit(),
        onBackgroundSubmit:
          submission.visibility === "draft"
            ? undefined
            : () => void submission.submit(undefined, true),
      })}
      ${titlePreparation.available()
        ? html`<div class="new-session-page__title-notice">
            <span>${t("newSession.titlePreparationDisclosure")}</span>
            ${preparedTitle
              ? html`<span class="new-session-page__prepared-title" role="status"
                  >${t("newSession.preparedTitle", { title: preparedTitle })}</span
                >`
              : nothing}
          </div>`
        : nothing}
      ${renderNewSessionIncognitoNotice(submission.visibility === "incognito")}
    </div>
  `;
}
