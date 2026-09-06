// Channel setup wizard modal: renders gateway wizard steps (note/select/text/
// confirm/multiselect) plus the WhatsApp QR linking phase after config write.
import { html, nothing, type TemplateResult } from "lit";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import {
  renderWizardBusyButton,
  renderWizardStepControls,
} from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import type { ChannelWizardState, ChannelWizardStep } from "./wizard-controller.ts";

type ChannelWizardViewProps = {
  wizard: ChannelWizardState;
  channelLabel: (channelId: string) => string;
  channelIconUrl?: (channelId: string) => string | undefined;
  channelHasPluginIcon?: (channelId: string) => boolean;
  // Pending multiselect toggles live in page state so re-renders keep them.
  multiselectValues: readonly unknown[];
  onToggleMultiselect: (value: unknown) => void;
  textValue: string;
  secretVisible: boolean;
  onTextInput: (value: string) => void;
  onToggleSecretVisibility: () => void;
  onAnswer: (value: unknown) => void;
  onClose: () => void;
  // WhatsApp QR linking phase (wizard done + channel === whatsapp).
  whatsappQrDataUrl: string | null;
  whatsappMessage: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
};

function stepIsBusy(props: ChannelWizardViewProps): boolean {
  return props.wizard.phase === "step" && props.wizard.busy;
}

function renderNoteStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  const message = step.message?.trim() ?? "";
  if (step.executor === "gateway") {
    return html`
      ${step.title ? html`<div class="channels-wizard__message">${step.title}</div>` : nothing}
      ${message ? html`<div class="channels-wizard__message">${message}</div>` : nothing}
      <div class="channels-wizard__footer">
        <button type="button" class="btn" @click=${() => props.onClose()}>
          ${t("common.cancel")}
        </button>
        ${renderWizardBusyButton(message || t("channels.setup.working"))}
      </div>
    `;
  }
  const looksLikeCode = message.includes("{") || message.includes("  ");
  const outputClass = `channels-wizard__output${looksLikeCode ? " channels-wizard__output--code" : ""}`;
  return html`
    ${step.title ? html`<div class="channels-wizard__message">${step.title}</div>` : nothing}
    ${message ? html`<div class=${outputClass}>${message}</div>` : nothing}
    <div class="channels-wizard__footer">
      ${
        stepIsBusy(props)
          ? renderWizardBusyButton(t("channels.setup.working"))
          : html`<button type="button" class="btn primary" @click=${() => props.onAnswer(null)}>
              ${t("channels.setup.continue")}
            </button>`
      }
    </div>
  `;
}

function renderStepBody(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  if (step.type === "note" || step.type === "progress" || step.type === "action") {
    return renderNoteStep(step, props);
  }
  return renderWizardStepControls({
    step,
    value:
      step.type === "multiselect"
        ? props.multiselectValues
        : step.type === "text"
          ? props.textValue
          : step.initialValue,
    busy: stepIsBusy(props),
    inputId: "channel-wizard-text-input",
    presentation: "channels",
    channelSelect: props.wizard.phase === "step" && props.wizard.channel === null,
    answerLabel: t("channels.setup.continue"),
    busyLabel: t("channels.setup.working"),
    sensitiveRevealed: props.secretVisible,
    onValueChange:
      step.type === "text"
        ? (value) => props.onTextInput(typeof value === "string" ? value : "")
        : props.onToggleMultiselect,
    onAnswer: props.onAnswer,
    onToggleSensitiveVisibility: props.onToggleSecretVisibility,
  });
}

function renderWhatsAppLinking(props: ChannelWizardViewProps) {
  const connected = props.whatsappConnected === true;
  return html`
    <div class="channels-wizard__message">
      ${connected ? t("channels.setup.whatsappLinked") : t("channels.setup.whatsappScanTitle")}
    </div>
    ${
      props.whatsappMessage
        ? html`<div class="channels-wizard__note">${props.whatsappMessage}</div>`
        : nothing
    }
    ${
      connected
        ? nothing
        : html`
            <div class="channels-wizard__qr">
              ${
                props.whatsappQrDataUrl
                  ? html`<img
                      src=${props.whatsappQrDataUrl}
                      alt=${t("channels.setup.whatsappQrAlt")}
                    />`
                  : props.whatsappBusy
                    ? nothing
                    : html`<div class="channels-wizard__spinner">
                        ${t("channels.setup.whatsappQrHint")}
                      </div>`
              }
            </div>
            <div class="channels-wizard__note">${t("channels.setup.whatsappScanHelp")}</div>
          `
    }
    <div class="channels-wizard__footer">
      ${
        connected
          ? html`
              <button type="button" class="btn primary" @click=${() => props.onClose()}>
                ${t("channels.setup.finish")}
              </button>
            `
          : html`
              ${
                props.whatsappBusy
                  ? renderWizardBusyButton(t("channels.setup.whatsappQrLoading"))
                  : html`
                      <button type="button" class="btn" @click=${() => props.onWhatsAppStart(true)}>
                        ${
                          props.whatsappQrDataUrl
                            ? t("channels.setup.regenerateQr")
                            : t("common.showQr")
                        }
                      </button>
                      ${
                        props.whatsappQrDataUrl
                          ? html`
                              <button
                                type="button"
                                class="btn primary"
                                @click=${() => props.onWhatsAppWait()}
                              >
                                ${t("common.waitForScan")}
                              </button>
                            `
                          : nothing
                      }
                    `
              }
              <button type="button" class="btn" @click=${() => props.onClose()}>
                ${t("channels.setup.linkLater")}
              </button>
            `
      }
    </div>
  `;
}

function renderDoneBody(channels: readonly string[], props: ChannelWizardViewProps) {
  if (channels.includes("whatsapp")) {
    return renderWhatsAppLinking(props);
  }
  const changed = channels.length > 0;
  return html`
    <div class="channels-wizard__message">
      ${t(changed ? "channels.setup.doneTitle" : "channels.setup.doneNoChangesTitle")}
    </div>
    <div class="channels-wizard__note">
      ${t(changed ? "channels.setup.doneBody" : "channels.setup.doneNoChangesBody")}
    </div>
    <div class="channels-wizard__footer">
      <button type="button" class="btn primary" @click=${() => props.onClose()}>
        ${t(changed ? "channels.setup.finish" : "common.close")}
      </button>
    </div>
  `;
}

function renderExternalStepLink(step: ChannelWizardStep | null) {
  if (!step?.externalUrl) {
    return nothing;
  }
  return html`
    <div class="channels-wizard__links">
      <a
        class="channels-wizard__link"
        href=${step.externalUrl}
        target="_blank"
        rel="noreferrer noopener"
      >
        ${t("channels.setup.openLink")}
      </a>
    </div>
  `;
}

export function renderChannelWizard(
  props: ChannelWizardViewProps,
): TemplateResult | typeof nothing {
  const wizard = props.wizard;
  if (wizard.phase === "idle") {
    return nothing;
  }
  const channel = wizard.channel;
  const label = channel ? props.channelLabel(channel) : t("channels.setup.genericTitle");
  const step = wizard.phase === "step" ? wizard.step : null;

  let body: unknown;
  if (wizard.phase === "starting") {
    body = html`<div class="channels-wizard__footer">
      ${renderWizardBusyButton(t("channels.setup.starting"))}
    </div>`;
  } else if (wizard.phase === "error") {
    body = html`
      <div class="channels-wizard__error">${wizard.message}</div>
      <div class="channels-wizard__footer">
        <button type="button" class="btn" @click=${() => props.onClose()}>
          ${t("common.close")}
        </button>
      </div>
    `;
  } else if (wizard.phase === "done") {
    body = renderDoneBody(wizard.channels, props);
  } else if (step) {
    body = html`
      ${
        wizard.phase === "step" && wizard.validationError
          ? html`<div class="channels-wizard__error">${wizard.validationError}</div>`
          : nothing
      }
      ${renderStepBody(step, props)}
    `;
  }

  return html`
    <openclaw-modal-dialog
      label=${t("channels.setup.dialogLabel", { channel: label })}
      @modal-cancel=${() => props.onClose()}
    >
      <div class="channels-wizard">
        <div class="channels-wizard__header">
          ${
            channel
              ? renderChannelIcon(channel, label, "tile", {
                  pluginIconUrl: props.channelIconUrl?.(channel),
                  preferPluginIcon: props.channelHasPluginIcon?.(channel),
                })
              : nothing
          }
          <div class="channels-wizard__heading">
            <h2>${t("channels.setup.title", { channel: label })}</h2>
            <div class="muted channels-wizard__subtitle">
              <span>${t("channels.setup.subtitle")}</span>
              ${
                channel
                  ? html`<a
                      class="channels-wizard__link"
                      href=${channelDocsUrl(channel)}
                      target="_blank"
                      rel="noreferrer noopener"
                      >${t("channels.setup.viewDocs")}</a
                    >`
                  : nothing
              }
            </div>
          </div>
        </div>
        <div class="channels-wizard__body">${renderExternalStepLink(step)} ${body}</div>
      </div>
    </openclaw-modal-dialog>
  `;
}
