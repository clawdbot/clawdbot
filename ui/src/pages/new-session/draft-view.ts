import { html, nothing, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { renderChatPermissionPicker } from "../chat/components/chat-permission-picker.ts";
import type { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { renderNewSessionDraftComposer, renderNewSessionDraftErrors } from "./draft-composer.ts";
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
  onMessage: (message: string, mentions?: readonly HumanMention[]) => void;
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
  const capabilities = submission.capabilities;
  const preferences = context?.theme.settings;
  const voiceControl = dictation.render(draftOwnerKey, preferences?.realtimeTalkInputDeviceId);
  const dictationLocked = dictation.active;
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
      ${renderTargetBar()} ${renderNewSessionDraftErrors(place, submission, isCatalogTarget)}
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
        mentions: submission.mentions,
        getMentions: () => submission.mentions,
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
        requiresModifier: preferences?.chatSendShortcut === "modifier-enter",
        requestUpdate,
        submitting: submission.submitting,
        textareaController: submission.composerTextarea,
        voiceControl,
        messageLocked: Boolean(submission.pendingPlacement.sessionKey),
        nativeTerminal: isCatalogTarget,
        onUnsupportedAttachment: () =>
          submission.setError(t("newSession.terminalAttachmentsUnsupported")),
        onInput: onMessage,
        onOpenImage,
        onVisibilityChange: (visibility) => {
          if (!submission.submitting && !submission.pendingPlacement.sessionKey) {
            submission.setVisibility(visibility);
          }
        },
        onSubmit: () => void submission.submit(),
        onBackgroundSubmit:
          submission.visibility === "draft" || isCatalogTarget
            ? undefined
            : () => void submission.submit(undefined, true),
      })}
      ${
        !isCatalogTarget
          ? renderNewSessionIncognitoNotice(submission.visibility === "incognito")
          : nothing
      }
    </div>
  `;
}
