import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ChatFollowUpMode } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { ControlUiFollowUpMode } from "../../../lib/chat/follow-up-mode.ts";
import type { ComposerDictationController } from "../composer-dictation.ts";
import type { ComposerTalkCapabilityStatus } from "../composer-microphone-picker.ts";
import {
  realtimeTalkDeviceIssueMessage,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkInputDevice,
} from "../realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";
import {
  renderChatVoiceStatus,
  renderMicrophoneActivity,
  voiceStatusLabel,
} from "./chat-voice-activity.ts";

export type ChatRunControlsProps = {
  canAbort: boolean;
  canSend: boolean;
  connected: boolean;
  draft: string;
  hasAttachments?: boolean;
  isBusy: boolean;
  followUpMode?: ControlUiFollowUpMode;
  alternateFollowUpMode?: ChatFollowUpMode;
  suggestionComposer?: boolean;
  submissionLabel?: string;
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
  onPrimaryActionPointerDown?: (event: PointerEvent) => void;
  onAbort?: () => void;
  onSend: (submissionAction?: Event) => void;
  onToggleVoice?: () => void;
  onToggleCamera?: () => void;
  microphonePicker?: TemplateResult | typeof nothing;
};

type MicrophonePickerProps = {
  devices: RealtimeTalkInputDevice[];
  loading: boolean;
  open: boolean;
  selectedDeviceId: string;
  voiceActive: boolean;
  issue: RealtimeTalkDeviceIssue | null;
  holdToDictate?: boolean;
  showRealtimeCapability?: boolean;
  realtimeStatus: ComposerTalkCapabilityStatus;
  dictationStatus: ComposerTalkCapabilityStatus;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (deviceId: string) => void;
  onHoldToDictateChange?: (enabled: boolean) => void;
  onOpenTalkSettings?: () => void;
  onOpenDictationSettings?: () => void;
};

/**
 * Drops focus from the device picker's trigger once a device has been chosen.
 * The dropdown restores focus there on close, which is right for a normal
 * trigger and wrong for this one: it is revealed by hover, so a focused trigger
 * keeps the microphone expanded after the pointer has moved on. Deferred to the
 * next task because the dropdown restores focus as part of closing.
 */
function releaseMicrophonePickerFocus(dropdown: EventTarget | null, item: HTMLElement): void {
  if (item.matches(":focus-visible")) {
    return;
  }
  if (!(dropdown instanceof HTMLElement)) {
    return;
  }
  queueMicrotask(() => {
    const trigger = dropdown.querySelector<HTMLElement>(".chat-talk-input-picker__trigger");
    if (trigger && document.activeElement === trigger) {
      trigger.blur();
    }
  });
}

export function renderMicrophonePicker(props: MicrophonePickerProps) {
  // Discovery reporting an issue with nothing enumerated is the browser stating
  // there is no capture route at all: a "System default" row would claim a
  // selection that cannot exist, so the popover shows one empty state instead
  // of a checked row stacked on two ways of saying the same thing.
  const unavailable = !props.loading && props.devices.length === 0 ? props.issue : null;
  // System default renders even while discovery runs: the dropdown's one-time
  // focus step needs at least one item or keyboard users never enter the menu.
  const options = unavailable
    ? []
    : [
        { deviceId: "", label: t("chat.composer.systemDefaultMicrophone") },
        ...(props.loading ? [] : props.devices),
      ];
  // A machine without a microphone and a browser that cannot enumerate are
  // facts, not faults; only the recoverable reasons earn the warn tone.
  const unavailableIsFault =
    unavailable !== null && unavailable !== "none-found" && unavailable !== "list-unsupported";
  const label = t("chat.composer.microphoneInput");
  const unavailableCapabilities = [
    {
      key: "realtime",
      label: t("chat.composer.realtimeTalkCapability"),
      status: props.realtimeStatus,
      unavailableReason: t("chat.composer.realtimeTalkProviderUnavailable"),
      onOpenSettings: props.onOpenTalkSettings,
    },
    {
      key: "dictation",
      label: t("chat.composer.dictationCapability"),
      status: props.dictationStatus,
      unavailableReason: t("chat.composer.dictationProviderUnavailableShort"),
      onOpenSettings: props.onOpenDictationSettings,
    },
  ].filter(
    (capability) =>
      capability.status !== "ready" &&
      (capability.key !== "realtime" || props.showRealtimeCapability !== false),
  );
  return html`
    <wa-dropdown
      class="chat-talk-input-picker"
      placement="top-end"
      aria-label=${label}
      .open=${props.open}
      @wa-show=${props.onOpen}
      @wa-hide=${props.onClose}
      @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
        props.onSelect(event.detail.item.value ?? "");
        releaseMicrophonePickerFocus(event.currentTarget, event.detail.item);
      }}
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
      ${
        unavailable
          ? html`<div
              class="chat-talk-input-picker__empty${
                unavailableIsFault ? " chat-talk-input-picker__empty--fault" : ""
              }"
              role="status"
            >
              ${realtimeTalkDeviceIssueMessage(unavailable, "audioinput")}
            </div>`
          : html`
              ${options.map((option) => {
                const selected = option.deviceId === props.selectedDeviceId;
                // Selection is radio-shaped, so the row stays a plain menu item:
                // wa-dropdown-item type="checkbox" paints its own leading check
                // and flips it on click, which would contradict this trailing
                // check whenever the click does not change the stored device.
                return html`
                  <wa-dropdown-item
                    class="chat-talk-input-picker__item"
                    value=${option.deviceId}
                    role="menuitemradio"
                    aria-checked=${String(selected)}
                    ${ref((element) => syncDropdownItemRadio(element, selected))}
                  >
                    <span slot="icon" class="chat-talk-input-picker__option-icon" aria-hidden="true"
                      >${icons.mic}</span
                    >
                    <span class="chat-talk-input-picker__label">${option.label}</span>
                    <span slot="details" class="chat-talk-input-picker__check" aria-hidden="true"
                      >${selected ? icons.check : nothing}</span
                    >
                  </wa-dropdown-item>
                `;
              })}
              ${
                props.loading
                  ? html`<div class="chat-talk-input-picker__note" role="status">
                      ${t("common.loading")}
                    </div>`
                  : nothing
              }
              ${
                props.issue
                  ? html`<div class="chat-talk-input-picker__warning" role="alert">
                      ${realtimeTalkDeviceIssueMessage(props.issue, "audioinput")}
                    </div>`
                  : nothing
              }
              ${
                props.voiceActive
                  ? html`<div class="chat-talk-input-picker__hint">
                      ${t("chat.composer.microphoneAppliesNextSession")}
                    </div>`
                  : nothing
              }
            `
      }
      ${
        unavailableCapabilities.length > 0
          ? html`
              <div class="chat-talk-input-picker__capabilities">
                ${unavailableCapabilities.map(
                  (capability) => html`
                    <div
                      class="chat-talk-input-picker__capability"
                      data-chat-talk-capability=${capability.key}
                      data-status=${capability.status}
                      role="status"
                    >
                      <span class="chat-talk-input-picker__capability-copy">
                        <strong>
                          ${
                            capability.status === "unavailable"
                              ? html`<span
                                  class="chat-talk-input-picker__capability-alert"
                                  aria-hidden="true"
                                  >${icons.alertTriangle}</span
                                >`
                              : nothing
                          }
                          <span>${capability.label}</span>
                        </strong>
                        <span>
                          ${
                            capability.status === "checking"
                              ? t("chat.composer.talkCapabilityChecking")
                              : capability.status === "unknown"
                                ? t("chat.composer.talkCapabilityUnknown")
                                : capability.unavailableReason
                          }
                        </span>
                      </span>
                      ${
                        capability.onOpenSettings
                          ? html`
                              <button
                                type="button"
                                class="chat-talk-input-picker__settings"
                                @click=${(event: MouseEvent) => {
                                  event.stopPropagation();
                                  capability.onOpenSettings?.();
                                }}
                              >
                                ${icons.settings}<span
                                  >${t("chat.composer.configureCapability")}</span
                                >
                              </button>
                            `
                          : nothing
                      }
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
      ${
        props.onHoldToDictateChange
          ? html`
              <div class="chat-talk-input-picker__preference">
                <span>${t("chat.composer.holdToDictate")}</span>
                <button
                  class="chat-controls__speed-toggle ${
                    props.holdToDictate !== false ? "chat-controls__speed-toggle--active" : ""
                  }"
                  type="button"
                  role="switch"
                  aria-checked=${props.holdToDictate !== false ? "true" : "false"}
                  aria-label=${t("chat.composer.holdToDictate")}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    props.onHoldToDictateChange?.(props.holdToDictate === false);
                  }}
                >
                  <span class="chat-controls__speed-toggle-thumb"></span>
                </button>
              </div>
            `
          : nothing
      }
    </wa-dropdown>
  `;
}

/**
 * What the microphone control itself reads. Narrower than the chat run controls
 * on purpose: the new-session composer offers the same control without a run to
 * abort, a send action, or a Talk session to toggle.
 */
type ComposerVoiceButtonProps = {
  connected: boolean;
  sending: boolean;
  isBusy: boolean;
  dictation?: ComposerDictationController;
  microphonePicker?: TemplateResult | typeof nothing;
  /**
   * What the control offers at rest. The chat composer's microphone also starts
   * Talk, so it promises voice input; a surface that only dictates says so
   * rather than offering something it cannot start.
   */
  idleLabel?: string;
  onDictationPointerDown?: (event: PointerEvent) => void;
  onDirectDictationStart?: () => void;
  onToggleVoice?: () => void;
};

export function renderComposerVoiceButton(props: ComposerVoiceButtonProps) {
  const active = props.dictation?.active === true;
  const arming = props.dictation?.arming === true;
  const finalizing = props.dictation?.finalizing === true;
  const holding = props.dictation?.locksComposer === true;
  const startsDictationDirectly =
    props.dictation !== undefined && props.onToggleVoice === undefined;
  const label = active
    ? t("chat.composer.dictationStopAndKeep")
    : (props.idleLabel ?? t("chat.composer.startVoiceInput"));
  const tooltip =
    props.dictation && !startsDictationDirectly && !(active || finalizing)
      ? t("chat.composer.voiceGestureHint")
      : label;
  // This shape owns pointer capture. Keep it stable while dictation rerenders,
  // or replacing the button releases capture and cancels the active hold.
  return html`
    <span class="chat-talk-control${holding ? " chat-talk-control--holding" : ""}">
      <openclaw-tooltip .content=${tooltip}>
        <button
          class=${
            active
              ? "chat-send-btn chat-send-btn--dictating"
              : `chat-send-btn chat-send-btn--voice${props.dictation && !startsDictationDirectly ? " chat-send-btn--hold-enabled" : ""}${arming ? " chat-send-btn--dictation-arming" : ""}`
          }
          type="button"
          @pointerdown=${(event: PointerEvent) => props.onDictationPointerDown?.(event)}
          @click=${(event: MouseEvent) => {
            if (active) {
              event.preventDefault();
              if (!finalizing) {
                void props.dictation?.finishActive();
              }
              return;
            }
            if (startsDictationDirectly) {
              event.preventDefault();
              props.onDirectDictationStart?.();
              props.dictation?.startDirect();
              return;
            }
            if (props.dictation) {
              props.dictation.handleClick(event);
            } else {
              props.onToggleVoice?.();
            }
          }}
          @contextmenu=${(event: MouseEvent) => props.dictation?.handleContextMenu(event)}
          ?disabled=${!active && (!props.connected || props.sending || props.isBusy)}
          aria-disabled=${String(finalizing)}
          aria-label=${label}
        >
          ${
            active
              ? icons.stop
              : html`
                  ${icons.mic}
                  <span class="agent-chat__control-label">${label}</span>
                `
          }
        </button>
      </openclaw-tooltip>
      ${props.microphonePicker}
    </span>
  `;
}

export function renderComposerDictationSendAction(
  dictation: ComposerDictationController,
  onSend: () => void,
  onPointerDown?: (event: PointerEvent) => void,
) {
  if (!dictation.active) {
    return nothing;
  }
  return html`
    ${
      dictation.connecting
        ? nothing
        : html`<span class="sr-only" role="status" aria-live="polite" aria-atomic="true"
            >${
              dictation.finalizing
                ? t("chat.composer.dictationFinalizing")
                : t("chat.composer.dictationListening")
            }</span
          >`
    }
    <openclaw-tooltip .content=${t("chat.runControls.send")}>
      <button
        class="chat-send-btn chat-send-btn--send chat-send-btn--dictation-commit"
        type="button"
        @pointerdown=${onPointerDown}
        @click=${async () => {
          if (dictation.finalizing) {
            return;
          }
          await dictation.finishActive();
          onSend();
        }}
        aria-disabled=${String(dictation.finalizing)}
        aria-label=${t("chat.runControls.send")}
      >
        ${icons.arrowUp}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderComposerDictationStatus(dictation?: ComposerDictationController) {
  if (!dictation?.active) {
    return nothing;
  }
  if (dictation.connecting) {
    return renderChatVoiceStatus({
      status: "connecting",
      detail: t("chat.composer.microphoneAccessPending"),
    });
  }
  const listening = !dictation.finalizing;
  return html`
    <div class="agent-chat__composer-status-stack">
      <div
        class=${`agent-chat__dictation-status${dictation.finalizing ? " agent-chat__dictation-status--finalizing" : ""}`}
      >
        <span
          class="agent-chat__dictation-phase${
            listening ? " agent-chat__dictation-phase--listening" : ""
          }"
        >
          ${
            dictation.finalizing
              ? t("chat.composer.dictationFinalizing")
              : t("chat.composer.dictationListening")
          }
        </span>
      </div>
    </div>
  `;
}

export function renderChatAbortAction(
  props: Pick<ChatRunControlsProps, "canAbort" | "onAbort" | "onPrimaryActionPointerDown">,
) {
  return props.canAbort
    ? html`
        <openclaw-tooltip .content=${t("chat.runControls.stop")}>
          <button
            class="chat-send-btn chat-send-btn--stop"
            @pointerdown=${props.onPrimaryActionPointerDown}
            @click=${props.onAbort}
            aria-label=${t("chat.runControls.stopGenerating")}
          >
            ${icons.stop}
            <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
          </button>
        </openclaw-tooltip>
      `
    : nothing;
}

export function renderChatPrimaryActions(props: ChatRunControlsProps) {
  const hasComposedContent = Boolean(props.draft.trim() || props.hasAttachments);
  const steersActiveRun = props.followUpMode === "steer";
  const interruptsActiveRun = props.followUpMode === "interrupt";
  const activeRunActionLabel =
    props.submissionLabel ??
    (props.suggestionComposer
      ? t("chat.sessionSuggestions.suggest")
      : !props.canAbort || props.followUpMode === undefined
        ? t("chat.runControls.send")
        : steersActiveRun
          ? t("chat.queue.steer")
          : interruptsActiveRun
            ? t("chat.runControls.send")
            : t("chat.runControls.queue"));
  const activeRunActionDescription =
    props.submissionLabel ??
    (props.suggestionComposer
      ? t("chat.sessionSuggestions.suggestMessage")
      : !props.canAbort || props.followUpMode === undefined
        ? t("chat.runControls.sendMessage")
        : steersActiveRun
          ? t("chat.followUpModeSteer")
          : interruptsActiveRun
            ? t("chat.runControls.sendMessage")
            : t("chat.runControls.queueMessage"));
  const alternateActionLabel = t(
    props.alternateFollowUpMode === "queue" ? "chat.runControls.queue" : "chat.queue.steer",
  );
  const alternateShortcutAvailable =
    props.alternateFollowUpMode && props.canSend && hasComposedContent;
  const activeRunActionTooltip = alternateShortcutAvailable
    ? `${activeRunActionLabel} ⏎ · ${alternateActionLabel} ${t("chat.sendShortcutModifierEnter")}`
    : activeRunActionLabel;
  // Preserve the click identity without mistaking it for a follow-up mode.
  const send = (event: Event) => props.onSend(event);
  const abortAction = renderChatAbortAction(props);

  // Transports keep the session active while reporting status "error"; the
  // alert row above the composer owns the error message, so the control keeps
  // only its stop affordance instead of a fake listening meter plus a
  // duplicate announcement.
  const voiceErrored = props.voiceStatus === "error";
  const voiceButton = renderComposerVoiceButton(props);
  // Dictation and Talk are one affordance to the operator — a microphone — so
  // the control shows whenever either route exists, and it always sits ahead of
  // the primary action rather than standing in for it.
  const voiceControl = props.dictation || props.onToggleVoice ? voiceButton : nothing;
  const mobileDictationControl = props.dictation
    ? html`
        <span class="chat-mobile-dictation-action">
          ${renderComposerVoiceButton({
            connected: props.connected,
            sending: props.sending,
            isBusy: props.isBusy,
            dictation: props.dictation,
            idleLabel: t("chat.composer.dictationCapability"),
          })}
        </span>
      `
    : nothing;
  const mobileTalkAction =
    !hasComposedContent && !props.dictation?.active && props.onToggleVoice
      ? html`
          <openclaw-tooltip
            class="chat-mobile-talk-action"
            .content=${t("chat.composer.realtimeTalkCapability")}
          >
            <button
              class="chat-send-btn chat-send-btn--talk-mode"
              type="button"
              @pointerdown=${props.onPrimaryActionPointerDown}
              @click=${props.onToggleVoice}
              ?disabled=${!props.connected || props.sending || props.isBusy}
              aria-label=${t("chat.composer.realtimeTalkCapability")}
            >
              ${icons.audioLines}
              <span class="agent-chat__control-label"
                >${t("chat.composer.realtimeTalkCapability")}</span
              >
            </button>
          </openclaw-tooltip>
        `
      : nothing;
  // Send holds the trailing edge whatever the draft is. During an active run the
  // same slot shows stop while empty, then becomes the follow-up action as soon
  // as the operator composes content; two competing primary buttons never render.
  const sendAction = html`
    <openclaw-tooltip
      .content=${
        props.sending
          ? t("chat.composer.sendingMessage")
          : hasComposedContent
            ? activeRunActionTooltip
            : t("chat.composer.emptyHint")
      }
    >
      <button
        class="chat-send-btn chat-send-btn--send${props.sending ? " chat-send-btn--sending" : ""}"
        @pointerdown=${props.onPrimaryActionPointerDown}
        @click=${send}
        ?disabled=${!props.canSend || props.sending || !hasComposedContent}
        aria-label=${
          props.sending
            ? t("chat.composer.sendingMessage")
            : hasComposedContent
              ? activeRunActionDescription
              : t("chat.composer.emptyHint")
        }
        aria-busy=${props.sending ? "true" : "false"}
      >
        ${
          props.sending
            ? html`<span class="btn__spinner" aria-hidden="true"></span>`
            : icons.arrowUp
        }
        <span class="agent-chat__control-label">${activeRunActionLabel}</span>
      </button>
    </openclaw-tooltip>
  `;
  const dictationSendAction = props.dictation
    ? renderComposerDictationSendAction(
        props.dictation,
        () => props.onSend(),
        props.onPrimaryActionPointerDown,
      )
    : nothing;
  const desktopPrimaryAction = props.dictation?.active
    ? dictationSendAction
    : props.canAbort
      ? hasComposedContent
        ? sendAction
        : abortAction
      : sendAction;
  const mobilePrimaryAction = props.dictation?.active
    ? dictationSendAction
    : hasComposedContent
      ? sendAction
      : props.canAbort
        ? abortAction
        : props.onToggleVoice
          ? mobileTalkAction
          : sendAction;
  const primaryActions =
    mobilePrimaryAction === desktopPrimaryAction
      ? html`<span class="chat-mobile-primary-action chat-desktop-primary-action"
          >${desktopPrimaryAction}</span
        >`
      : html`
          <span class="chat-mobile-primary-action">${mobilePrimaryAction}</span>
          <span class="chat-desktop-primary-action">${desktopPrimaryAction}</span>
        `;
  return html`
    ${
      props.voiceActive && props.onToggleVoice
        ? html`
            <span class="chat-talk-control chat-talk-control--active">
              <openclaw-tooltip .content=${t("chat.composer.stopVoiceInput")}>
                <button
                  class="chat-send-btn chat-send-btn--voice-live${
                    voiceErrored ? " chat-send-btn--voice-error" : ""
                  }"
                  @click=${props.onToggleVoice}
                  aria-label=${t("chat.composer.stopVoiceInput")}
                >
                  ${
                    voiceErrored
                      ? nothing
                      : renderMicrophoneActivity({
                          status: props.voiceStatus,
                          inputLevel: props.voiceInputLevel,
                        })
                  }
                  <span class="chat-send-btn__voice-stop-glyph">${icons.stop}</span>
                </button>
              </openclaw-tooltip>
              ${props.microphonePicker}
            </span>
            ${
              voiceErrored || props.voiceStatus === "connecting"
                ? nothing
                : html`
                    <span
                      class="sr-only agent-chat__voice-status"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                      >${voiceStatusLabel(props.voiceStatus, props.voiceDetail)}</span
                    >
                  `
            }
            ${
              props.voiceVideoCapable && props.onToggleCamera
                ? html`
                    <openclaw-tooltip
                      .content=${
                        props.voiceVideoEnabled
                          ? t("chat.composer.turnCameraOff")
                          : t("chat.composer.turnCameraOn")
                      }
                    >
                      <button
                        class="chat-send-btn chat-send-btn--voice"
                        @click=${props.onToggleCamera}
                        ?disabled=${
                          props.voiceVideoPending ||
                          props.voiceStatus === "connecting" ||
                          props.voiceStatus === "error"
                        }
                        aria-label=${
                          props.voiceVideoEnabled
                            ? t("chat.composer.turnCameraOff")
                            : t("chat.composer.turnCameraOn")
                        }
                        aria-pressed=${props.voiceVideoEnabled ? "true" : "false"}
                      >
                        ${props.voiceVideoEnabled ? icons.cameraOff : icons.camera}
                        <span class="agent-chat__control-label"
                          >${
                            props.voiceVideoEnabled
                              ? t("chat.composer.turnCameraOff")
                              : t("chat.composer.turnCameraOn")
                          }</span
                        >
                      </button>
                    </openclaw-tooltip>
                  `
                : nothing
            }
            <span class="chat-mobile-primary-action chat-desktop-primary-action"
              >${abortAction}</span
            >
          `
        : html` ${voiceControl} ${mobileDictationControl} ${primaryActions} `
    }
  `;
}
