import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { RealtimeTalkInputDevice } from "../realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import { renderMicrophoneActivity, voiceStatusLabel } from "./chat-voice-activity.ts";

export type ChatRunControlsProps = {
  canAbort: boolean;
  canSend: boolean;
  connected: boolean;
  draft: string;
  hasAttachments?: boolean;
  hasMessages: boolean;
  isBusy: boolean;
  followUpMode?: ControlUiFollowUpMode;
  suggestionComposer?: boolean;
  sending: boolean;
  voiceActive?: boolean;
  voiceStatus?: RealtimeTalkStatus;
  voiceDetail?: string | null;
  voiceInputLevel?: RealtimeTalkLevelSignal;
  voiceVideoCapable?: boolean;
  voiceVideoEnabled?: boolean;
  voiceVideoPending?: boolean;
  dictation?: ComposerDictationController;
  onDictationPointerDown?: (event: PointerEvent) => void;
  onAbort?: () => void;
  onExport: () => void;
  onNewSession: () => void;
  onSend: () => void;
  onStoreDraft: (draft: string) => void;
  onToggleVoice?: () => void;
  onToggleCamera?: () => void;
  microphonePicker?: TemplateResult | typeof nothing;
  showPrimary?: boolean;
  showSecondary?: boolean;
};

type MicrophonePickerProps = {
  devices: RealtimeTalkInputDevice[];
  loading: boolean;
  open: boolean;
  selectedDeviceId: string;
  voiceActive: boolean;
  warning: string | null;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
};

export function renderMicrophonePicker(props: MicrophonePickerProps) {
  // System default renders even while discovery runs: the dropdown's one-time
  // focus step needs at least one item or keyboard users never enter the menu.
  const options = props.loading
    ? [{ deviceId: "", label: t("chat.composer.systemDefaultMicrophone") }]
    : [{ deviceId: "", label: t("chat.composer.systemDefaultMicrophone") }, ...props.devices];
  const label = t("chat.composer.microphoneInput");
  return html`
    <wa-dropdown
      class="chat-talk-input-picker"
      placement="top-end"
      aria-label=${label}
      .open=${props.open}
      @wa-show=${props.onOpen}
      @wa-hide=${props.onClose}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
        props.onSelect(event.detail.item.value ?? "")}
    >
      <button
        slot="trigger"
        type="button"
        class="chat-talk-input-picker__trigger"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${String(props.open)}
      >
        ${icons.chevronDown}
      </button>
      <div class="chat-talk-input-picker__heading">${label}</div>
      ${options.map((option) => {
        const selected = option.deviceId === props.selectedDeviceId;
        return html`
          <wa-dropdown-item
            class="chat-talk-input-picker__item"
            value=${option.deviceId}
            type="checkbox"
            role="menuitemradio"
            aria-checked=${String(selected)}
            ${ref((element) => syncDropdownItemRadio(element, selected))}
          >
            <span class="chat-talk-input-picker__label">${option.label}</span>
            <span slot="details" class="chat-talk-input-picker__check" aria-hidden="true"
              >${selected ? icons.check : nothing}</span
            >
          </wa-dropdown-item>
        `;
      })}
      ${props.loading
        ? html`<div class="chat-talk-input-picker__note" role="status">${t("common.loading")}</div>`
        : nothing}
      ${!props.loading && props.devices.length === 0
        ? html`<div class="chat-talk-input-picker__note">${t("chat.composer.noMicrophones")}</div>`
        : nothing}
      ${props.warning
        ? html`<div class="chat-talk-input-picker__warning" role="alert">${props.warning}</div>`
        : nothing}
      ${props.voiceActive
        ? html`<div class="chat-talk-input-picker__hint">
            ${t("chat.composer.microphoneAppliesNextSession")}
          </div>`
        : nothing}
    </wa-dropdown>
  `;
}

function renderComposerVoiceButton(props: ChatRunControlsProps) {
  const active = props.dictation?.active === true;
  const finalizing = props.dictation?.finalizing === true;
  const holding = props.dictation?.locksComposer === true;
  const label = finalizing
    ? t("chat.composer.dictationFinalizing")
    : active
      ? t("chat.composer.dictationReleaseToInsert")
      : t("chat.composer.startVoiceInput");
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return html`
    <span class="chat-talk-control">
      <openclaw-tooltip .content=${label}>
        <button
          class=${active
            ? `chat-send-btn chat-send-btn--dictating${finalizing ? " chat-send-btn--dictation-finalizing" : ""}`
            : `chat-send-btn chat-send-btn--voice${props.dictation ? " chat-send-btn--hold-enabled" : ""}`}
          type="button"
          @pointerdown=${(event: PointerEvent) => props.onDictationPointerDown?.(event)}
          @click=${(event: MouseEvent) =>
            props.dictation ? props.dictation.handleClick(event) : props.onToggleVoice?.()}
          @contextmenu=${(event: MouseEvent) => props.dictation?.handleContextMenu(event)}
          ?disabled=${finalizing ||
          (!active && (!props.connected || props.sending || props.isBusy))}
          aria-label=${label}
        >
          ${finalizing
            ? icons.loader
            : active
              ? html`
                  ${renderMicrophoneActivity({
                    status: props.dictation?.connecting ? "connecting" : "listening",
                    inputLevel: props.dictation?.inputLevel,
                  })}
                  <span class="chat-send-btn__dictation-time">${props.dictation?.elapsed}</span>
                `
              : html`
                  ${icons.mic}
                  <span class="agent-chat__control-label">${label}</span>
                `}
        </button>
      </openclaw-tooltip>
      ${holding ? nothing : props.microphonePicker}
    </span>
  `;
}

export function renderChatPrimaryActions(props: ChatRunControlsProps) {
  const hasComposedContent = Boolean(props.draft.trim() || props.hasAttachments);
  const steersActiveRun = props.followUpMode === "steer";
  const interruptsActiveRun = props.followUpMode === "interrupt";
  const activeRunActionLabel = props.suggestionComposer
    ? t("chat.sessionSuggestions.suggest")
    : props.followUpMode === undefined
      ? t("chat.runControls.send")
      : steersActiveRun
        ? t("chat.queue.steer")
        : interruptsActiveRun
          ? t("chat.runControls.send")
          : t("chat.runControls.queue");
  const activeRunActionDescription = props.suggestionComposer
    ? t("chat.sessionSuggestions.suggestMessage")
    : props.followUpMode === undefined
      ? t("chat.runControls.sendMessage")
      : steersActiveRun
        ? t("chat.followUpModeSteer")
        : interruptsActiveRun
          ? t("chat.runControls.sendMessage")
          : t("chat.runControls.queueMessage");
  const storeDraftAndSend = () => {
    if (props.draft.trim()) {
      props.onStoreDraft(props.draft);
    }
    props.onSend();
  };
  const abortAction = props.canAbort
    ? html`
        <openclaw-tooltip .content=${t("chat.runControls.stop")}>
          <button
            class="chat-send-btn chat-send-btn--stop"
            @click=${props.onAbort}
            aria-label=${t("chat.runControls.stopGenerating")}
          >
            ${icons.stop}
            <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;

  // Transports keep the session active while reporting status "error"; the
  // alert row above the composer owns the error message, so the control keeps
  // only its stop affordance instead of a fake listening meter plus a
  // duplicate announcement.
  const voiceErrored = props.voiceStatus === "error";
  const voiceButton = renderComposerVoiceButton(props);
  const sendAction = html`
    <openclaw-tooltip
      .content=${props.suggestionComposer
        ? t("chat.sessionSuggestions.suggestMessage")
        : props.isBusy
          ? t("chat.runControls.queue")
          : t("chat.runControls.send")}
    >
      <button
        class="chat-send-btn"
        @click=${storeDraftAndSend}
        ?disabled=${!props.canSend || props.sending}
        aria-label=${props.suggestionComposer
          ? t("chat.sessionSuggestions.suggestMessage")
          : props.isBusy
            ? t("chat.runControls.queueMessage")
            : t("chat.runControls.sendMessage")}
      >
        ${icons.arrowUp}
        <span class="agent-chat__control-label"
          >${props.suggestionComposer
            ? t("chat.sessionSuggestions.suggest")
            : props.isBusy
              ? t("chat.runControls.queue")
              : t("chat.runControls.send")}</span
        >
      </button>
    </openclaw-tooltip>
  `;
  const dictationPrimaryAction = html`
    ${props.dictation?.active || !hasComposedContent ? nothing : sendAction} ${voiceButton}
  `;
  return html`
    ${props.voiceActive && props.onToggleVoice
      ? html`
          <span class="chat-talk-control chat-talk-control--active">
            <openclaw-tooltip .content=${t("chat.composer.stopVoiceInput")}>
              <button
                class="chat-send-btn chat-send-btn--voice-live${voiceErrored
                  ? " chat-send-btn--voice-error"
                  : ""}"
                @click=${props.onToggleVoice}
                aria-label=${t("chat.composer.stopVoiceInput")}
              >
                ${voiceErrored
                  ? nothing
                  : renderMicrophoneActivity({
                      status: props.voiceStatus,
                      inputLevel: props.voiceInputLevel,
                    })}
                <span class="chat-send-btn__voice-stop-glyph">${icons.stop}</span>
              </button>
            </openclaw-tooltip>
            ${props.microphonePicker}
          </span>
          ${voiceErrored
            ? nothing
            : html`
                <span
                  class="agent-chat__sr-only agent-chat__voice-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  >${voiceStatusLabel(props.voiceStatus, props.voiceDetail)}</span
                >
              `}
          ${props.voiceVideoCapable && props.onToggleCamera
            ? html`
                <openclaw-tooltip
                  .content=${props.voiceVideoEnabled
                    ? t("chat.composer.turnCameraOff")
                    : t("chat.composer.turnCameraOn")}
                >
                  <button
                    class="chat-send-btn chat-send-btn--voice"
                    @click=${props.onToggleCamera}
                    ?disabled=${props.voiceVideoPending ||
                    props.voiceStatus === "connecting" ||
                    props.voiceStatus === "error"}
                    aria-label=${props.voiceVideoEnabled
                      ? t("chat.composer.turnCameraOff")
                      : t("chat.composer.turnCameraOn")}
                    aria-pressed=${props.voiceVideoEnabled ? "true" : "false"}
                  >
                    ${props.voiceVideoEnabled ? icons.cameraOff : icons.camera}
                    <span class="agent-chat__control-label"
                      >${props.voiceVideoEnabled
                        ? t("chat.composer.turnCameraOff")
                        : t("chat.composer.turnCameraOn")}</span
                    >
                  </button>
                </openclaw-tooltip>
              `
            : nothing}
          ${abortAction}
        `
      : props.canAbort
        ? html`
            ${hasComposedContent
              ? html`
                  <openclaw-tooltip .content=${activeRunActionLabel}>
                    <button
                      class="chat-send-btn"
                      @click=${storeDraftAndSend}
                      ?disabled=${!props.canSend || props.sending}
                      aria-label=${activeRunActionDescription}
                    >
                      ${icons.arrowUp}
                      <span class="agent-chat__control-label">${activeRunActionLabel}</span>
                    </button>
                  </openclaw-tooltip>
                `
              : nothing}
            <openclaw-tooltip .content=${t("chat.runControls.stop")}>
              <button
                class="chat-send-btn chat-send-btn--stop"
                @click=${props.onAbort}
                aria-label=${t("chat.runControls.stopGenerating")}
              >
                ${icons.stop}
                <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
              </button>
            </openclaw-tooltip>
          `
        : props.dictation
          ? dictationPrimaryAction
          : hasComposedContent || !props.onToggleVoice
            ? sendAction
            : voiceButton}
  `;
}
