import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { RealtimeTalkLevelSignal } from "../realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";

const BAR_GAINS = [0.38, 0.62, 0.84, 1, 0.84, 0.62, 0.38];
const MICROPHONE_ACTIVITY_TAG = "openclaw-microphone-activity";
const EMPTY_LEVEL_SIGNAL = new RealtimeTalkLevelSignal();

class MicrophoneActivityElement extends HTMLElement {
  private levelSignal: RealtimeTalkLevelSignal | undefined;
  private unsubscribe: (() => void) | null = null;

  set signal(signal: RealtimeTalkLevelSignal | undefined) {
    if (signal === this.levelSignal) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.levelSignal = signal;
    this.ensureBars();
    this.renderLevel(signal?.value ?? 0);
    if (this.isConnected) {
      this.subscribe();
    }
  }

  connectedCallback(): void {
    this.ensureBars();
    this.subscribe();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ensureBars(): void {
    if (!this.firstElementChild) {
      for (const [index] of BAR_GAINS.entries()) {
        const bar = document.createElement("span");
        bar.className = "agent-chat__voice-activity-bar";
        bar.style.setProperty("--talk-bar-delay", `${index * -70}ms`);
        this.append(bar);
      }
    }
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.levelSignal?.subscribe((level) => this.renderLevel(level)) ?? null;
  }

  private renderLevel(level: number): void {
    this.dataset.level = String(level);
    for (const [index, bar] of [...this.children].entries()) {
      const gain = BAR_GAINS[index] ?? 1;
      (bar as HTMLElement).style.setProperty(
        "--talk-bar-scale",
        String(0.18 + level * gain * 0.82),
      );
    }
  }
}

if (!customElements.get(MICROPHONE_ACTIVITY_TAG)) {
  customElements.define(MICROPHONE_ACTIVITY_TAG, MicrophoneActivityElement);
}

function activeStatus(
  status: RealtimeTalkStatus | undefined,
): "connecting" | "listening" | "thinking" {
  return status === "connecting" || status === "thinking" ? status : "listening";
}

export function voiceStatusLabel(
  status: RealtimeTalkStatus | undefined,
  detail: string | null | undefined,
) {
  const explicitDetail = detail?.trim();
  if (explicitDetail) {
    return explicitDetail;
  }
  if (status === "thinking") {
    return "Asking OpenClaw...";
  }
  if (status === "connecting") {
    return "Connecting voice input...";
  }
  return "Listening...";
}

type MicrophoneActivityProps = {
  status?: RealtimeTalkStatus;
  inputLevel?: RealtimeTalkLevelSignal;
};

// Class names and data attributes are asserted by the talk e2e suite; the
// element is decorative inside the labeled stop-voice button, so it stays
// aria-hidden while `data-status` keeps driving the bar animations.
export function renderMicrophoneActivity(props: MicrophoneActivityProps): TemplateResult {
  return html`
    <openclaw-microphone-activity
      class="agent-chat__voice-activity"
      data-status=${activeStatus(props.status)}
      data-source="microphone"
      aria-hidden="true"
      .signal=${props.inputLevel ?? EMPTY_LEVEL_SIGNAL}
    >
    </openclaw-microphone-activity>
  `;
}

type ChatVoiceErrorProps = {
  status?: RealtimeTalkStatus;
  detail?: string | null;
  onDismissError?: () => void;
};

export function renderChatVoiceError(props: ChatVoiceErrorProps): TemplateResult | typeof nothing {
  if (props.status !== "error" || !props.detail) {
    return nothing;
  }
  return html`
    <div class="agent-chat__stt-interim agent-chat__talk-status" role="alert">
      <span class="agent-chat__talk-status-text">${props.detail}</span>
      ${props.onDismissError
        ? html`
            <openclaw-tooltip .content=${t("chat.composer.dismissVoiceInputError")}>
              <button
                class="callout__dismiss"
                type="button"
                @click=${props.onDismissError}
                aria-label=${t("chat.composer.dismissVoiceInputError")}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          `
        : nothing}
    </div>
  `;
}
