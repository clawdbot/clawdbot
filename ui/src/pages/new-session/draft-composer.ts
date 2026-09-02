import { html, nothing, type TemplateResult } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { resolveIdentityHue } from "../../lib/identity-avatar.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/text.css";
import "../../styles/chat/grouped.css";
import "../../styles/chat/working-indicator.css";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import { renderAssistantAttachments } from "../chat/components/chat-message-attachments.ts";
import { renderMessageImages } from "../chat/components/chat-message-images.ts";
import { extractImages, extractMessageAttachments } from "../chat/components/chat-message-media.ts";
import {
  detectJson,
  renderMessageJson,
  renderMessageMarkdown,
  resolveMessageDisplayMarkdown,
} from "../chat/components/chat-message-text.ts";
import { renderChatWorkingIndicator } from "../chat/components/chat-working-indicator.ts";
import type { buildLocalUserMessage } from "../chat/user-message-content.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import {
  NewSessionComposerTextareaController,
  renderDraftError,
  renderNewSessionComposer,
} from "./composer.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import type { NewSessionModelControl } from "./model-control.ts";

export function renderNewSessionBody(options: {
  error: string | null;
  pendingMessage: ReturnType<typeof buildLocalUserMessage>;
  submitting: boolean;
  renderDraft: () => TemplateResult;
  onOpenImage: (item: ImageLightboxItem) => void;
}) {
  const { pendingMessage } = options;
  const draftLocked = options.submitting && !pendingMessage;
  // Late cleanup can fail while a replacement submission is still pending.
  return html`
    <div class="sr-only" role="status" aria-live="polite">
      ${pendingMessage ? t("newSession.starting") : nothing}
    </div>
    <div
      class="new-session-page__scroll ${pendingMessage ? "chat-thread chat-thread--direct" : ""}"
      ?inert=${draftLocked}
      aria-busy=${String(draftLocked)}
      @mousedown=${beginNativeWindowDragFromTopInset}
    >
      ${options.error ? renderDraftError(options.error) : nothing}
      ${pendingMessage
        ? renderNewSessionSubmission(pendingMessage, options.onOpenImage)
        : options.renderDraft()}
    </div>
  `;
}

function renderNewSessionSubmission(
  message: NonNullable<ReturnType<typeof buildLocalUserMessage>>,
  onOpenImage: (item: ImageLightboxItem) => void,
) {
  const key = "new-session-submission";
  const normalized = normalizeMessage(message);
  const senderHue = normalized.sender ? resolveIdentityHue(normalized.sender) : null;
  const images = extractImages(message);
  const attachments = extractMessageAttachments(message, normalized.content);
  const markdown = resolveMessageDisplayMarkdown(message, normalized);
  const json = detectJson(markdown);
  const imageOptions = { onOpenImage };
  // Keep Markdown passive until Chat mounts its interaction owners. Uploaded
  // images have their own lightbox handler and remain interactive while pending.
  return html`<div class="new-session-page__starting chat-thread-inner">
    <div
      class="chat-group user ${senderHue === null ? "" : "chat-group--sender-tint"}"
      style=${senderHue === null ? nothing : `--chat-sender-hue: ${senderHue}`}
      data-chat-row-key=${key}
    >
      <div class="chat-group-messages">
        <div
          class="chat-bubble ${images.length ? "chat-bubble--with-images" : ""}"
          data-message-id=${key}
          data-message-text=${markdown || nothing}
        >
          ${renderMessageImages(images, imageOptions)}
          ${renderAssistantAttachments(attachments, imageOptions, undefined, undefined, false)}
          ${json
            ? renderMessageJson(json)
            : markdown
              ? renderMessageMarkdown(
                  markdown,
                  key,
                  { role: "user", isStreaming: false },
                  { codeBlockChrome: "none" },
                )
              : nothing}
        </div>
      </div>
    </div>
    <div class="chat-group assistant chat-group--working">
      <div class="chat-group-messages">
        ${renderChatWorkingIndicator(
          { kind: "reading-indicator", key, startedAt: message.timestamp },
          { startupLabel: t("newSession.starting") },
        )}
      </div>
    </div>
  </div>`;
}

export function renderNewSessionDraftComposer(options: {
  agent?: GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: ApplicationContext | undefined;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  message: string;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  modelControl: NewSessionModelControl;
  permissionControl?: TemplateResult;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult | typeof nothing;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: TemplateResult | typeof nothing;
  nativeTerminal?: boolean;
  onUnsupportedAttachment?: () => void;
  submitting: boolean;
  messageLocked?: boolean;
  onInput: (message: string) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
  onBackgroundSubmit?: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  const commandClient = options.nativeTerminal
    ? null
    : (options.context?.gateway.snapshot.client ?? null);
  options.textareaController.syncSkillCommandOwner(
    commandClient,
    options.agentId,
    options.draftOwnerKey,
  );
  return renderNewSessionComposer({
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    message: options.message,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    capabilityMenu: options.capabilityMenu,
    toolOverrides: options.toolOverrides,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    permissionControl: options.permissionControl,
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    readSignal,
    requiresModifier: options.requiresModifier,
    requestUpdate: options.requestUpdate,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              options.textareaController.ownsSkillCommands(
                commandClient,
                options.agentId,
                options.draftOwnerKey,
              ),
          })
      : undefined,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    dictationActive: options.dictationActive,
    dictationPreview: options.dictationPreview,
    dictationStatus: options.dictationStatus,
    nativeTerminal: options.nativeTerminal,
    onUnsupportedAttachment: options.onUnsupportedAttachment,
    submitting: options.submitting,
    textareaController: options.textareaController,
    voiceControl: options.voiceControl,
    messageLocked: options.messageLocked,
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
    onBackgroundSubmit: options.onBackgroundSubmit,
  });
}
