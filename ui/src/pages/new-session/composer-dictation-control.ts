import { html } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  renderComposerDictationSendAction,
  renderComposerDictationStatus,
  renderComposerVoiceButton,
  renderMicrophonePicker,
} from "../chat/components/chat-composer-controls.ts";
import { ComposerDictationController } from "../chat/composer-dictation.ts";
import { ComposerMicrophonePicker } from "../chat/composer-microphone-picker.ts";
import type { NewSessionComposerTextareaController } from "./composer.ts";

type NewSessionDictationOptions = {
  textarea: NewSessionComposerTextareaController;
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  canCommit: () => boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSubmit: () => void;
  requestUpdate: () => void;
};

/**
 * Dictation for the new-session draft. This surface has no Talk capability, so
 * its microphone enters the shared dictation session directly on click.
 */
export class NewSessionDictationControl {
  private readonly devicePicker: ComposerMicrophonePicker;
  private dictation: ComposerDictationController | null = null;
  private owner: { key: string } | null = null;

  constructor(private readonly options: NewSessionDictationOptions) {
    this.devicePicker = new ComposerMicrophonePicker(options.requestUpdate);
  }

  dispose(): void {
    this.owner = null;
    this.dictation?.dispose();
    this.dictation = null;
    this.devicePicker.dispose();
  }

  get active(): boolean {
    return this.dictation?.active === true;
  }

  previewDraft(): string | undefined {
    const dictation = this.dictation;
    return dictation?.active
      ? this.options.textarea.previewTranscript(dictation.transcript)
      : undefined;
  }

  renderStatus() {
    return renderComposerDictationStatus(this.dictation ?? undefined);
  }

  render(ownerKey: string) {
    if (this.owner?.key !== ownerKey) {
      this.owner = { key: ownerKey };
      this.dictation?.dispose();
      this.dictation = null;
    }
    const owner = this.owner;
    const ownsDraft = () => this.owner === owner;
    const client = this.options.getClient();
    const connected = this.options.isConnected() && client !== null;
    this.devicePicker.syncCatalog(client, connected);
    const enabled = this.options.canCommit();
    const dictationOptions = {
      client,
      connected,
      enabled,
      dictationAvailable: this.devicePicker.dictationStatus === "ready",
      realtimeTalkActive: false,
      onCommit: (transcript: string) => {
        // Route changes replace draft ownership. Object identity keeps even an
        // A -> B -> A transition from accepting the prior route's snapshot.
        if (!ownsDraft() || !this.options.canCommit()) {
          return;
        }
        const next = this.options.textarea.insertTranscript(transcript);
        if (next !== null) {
          this.options.onMessage(next);
        }
        this.options.requestUpdate();
      },
      onError: (message: string) => {
        if (ownsDraft()) {
          this.options.onError(message);
        }
      },
      onStateChange: () => {
        if (ownsDraft()) {
          this.options.requestUpdate();
        }
      },
      onDictationUnavailable: this.devicePicker.handleOpen,
    };
    this.dictation ??= new ComposerDictationController(dictationOptions);
    this.dictation.update(dictationOptions);
    const dictation = this.dictation;

    return html`
      ${renderComposerVoiceButton({
        connected,
        sending: false,
        isBusy: !enabled,
        dictation,
        idleLabel: t("newSession.dictate"),
        microphonePicker: renderMicrophonePicker({
          devices: this.devicePicker.devices,
          loading: this.devicePicker.loading,
          open: this.devicePicker.open,
          selectedDeviceId: loadSettings().realtimeTalkInputDeviceId?.trim() ?? "",
          voiceActive: false,
          issue: this.devicePicker.issue,
          showRealtimeCapability: false,
          realtimeStatus: this.devicePicker.realtimeStatus,
          dictationStatus: this.devicePicker.dictationStatus,
          onOpen: this.devicePicker.handleOpen,
          onClose: this.devicePicker.handleClose,
          onSelect: (deviceId: string) => {
            patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
            this.devicePicker.handleClose();
          },
        }),
        onDirectDictationStart: () => this.options.textarea.captureSelection(),
      })}
      ${renderComposerDictationSendAction(dictation, () => {
        if (ownsDraft() && this.options.canCommit()) {
          this.options.onSubmit();
        }
      })}
    `;
  }
}
