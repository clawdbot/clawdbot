// Channel setup wizard modal: renders gateway wizard steps (note/select/text/
// confirm/multiselect) plus the WhatsApp QR linking phase after config write.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { channelDocsUrl, channelHubMeta, renderChannelArt } from "./hub-meta.ts";
import type {
  ChannelWizardState,
  ChannelWizardStep,
  ChannelWizardStepOption,
} from "./wizard-controller.ts";

type ChannelWizardViewProps = {
  wizard: ChannelWizardState;
  channelLabel: (channelId: string) => string;
  // Pending multiselect toggles live in page state so re-renders keep them.
  multiselectValues: readonly unknown[];
  onToggleMultiselect: (value: unknown) => void;
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

function stepKeyboardValue(step: ChannelWizardStep): string {
  return typeof step.initialValue === "string" ? step.initialValue : "";
}

function renderNoteStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  const message = step.message?.trim() ?? "";
  const looksLikeCode = message.includes("{") || message.includes("  ");
  return html`
    ${step.title ? html`<div class="channels-wizard__message">${step.title}</div>` : nothing}
    ${message
      ? html`<div
          class="channels-wizard__note ${looksLikeCode ? "channels-wizard__note--code" : ""}"
        >
          ${message}
        </div>`
      : nothing}
    ${message
      ? html`
          <div class="channels-wizard__links">
            <button
              type="button"
              class="btn btn--sm"
              @click=${() => void navigator.clipboard?.writeText(message)}
            >
              ${t("channels.setup.copyText")}
            </button>
          </div>
        `
      : nothing}
    <div class="channels-wizard__footer">
      <button type="button" class="btn primary" @click=${() => props.onAnswer(null)}>
        ${t("channels.setup.continue")}
      </button>
    </div>
  `;
}

function renderSelectStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  const options = step.options ?? [];
  return html`
    <div class="channels-wizard__message">${step.message ?? ""}</div>
    <div class="channels-wizard__options" role="listbox">
      ${options.map(
        (option: ChannelWizardStepOption) => html`
          <button
            type="button"
            class="channels-wizard__option"
            aria-pressed=${option.value === step.initialValue ? "true" : "false"}
            @click=${() => props.onAnswer(option.value)}
          >
            <span class="channels-wizard__option-label">${option.label}</span>
            ${option.hint
              ? html`<span class="channels-wizard__option-hint">${option.hint}</span>`
              : nothing}
          </button>
        `,
      )}
    </div>
  `;
}

function renderMultiselectStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  const options = step.options ?? [];
  const selected = new Set(props.multiselectValues);
  return html`
    <div class="channels-wizard__message">${step.message ?? ""}</div>
    <div class="channels-wizard__options">
      ${options.map(
        (option: ChannelWizardStepOption) => html`
          <button
            type="button"
            class="channels-wizard__option"
            aria-pressed=${selected.has(option.value) ? "true" : "false"}
            @click=${() => props.onToggleMultiselect(option.value)}
          >
            <span class="channels-wizard__option-label">
              ${selected.has(option.value) ? "☑" : "☐"} ${option.label}
            </span>
            ${option.hint
              ? html`<span class="channels-wizard__option-hint">${option.hint}</span>`
              : nothing}
          </button>
        `,
      )}
    </div>
    <div class="channels-wizard__footer">
      <button
        type="button"
        class="btn primary"
        @click=${() => props.onAnswer([...props.multiselectValues])}
      >
        ${t("channels.setup.continue")}
      </button>
    </div>
  `;
}

function renderTextStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("wizard-text") as HTMLInputElement | null;
    props.onAnswer(input?.value ?? "");
  };
  return html`
    <form @submit=${submit}>
      <div class="channels-wizard__message">${step.message ?? ""}</div>
      <input
        class="input"
        style="margin-top: 10px; width: 100%;"
        name="wizard-text"
        type=${step.sensitive ? "password" : "text"}
        autocomplete=${step.sensitive ? "off" : "on"}
        placeholder=${step.placeholder ?? ""}
        .value=${stepKeyboardValue(step)}
      />
      <div class="channels-wizard__footer" style="margin-top: 12px;">
        <button type="submit" class="btn primary">${t("channels.setup.continue")}</button>
      </div>
    </form>
  `;
}

function renderConfirmStep(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  return html`
    <div class="channels-wizard__message">${step.message ?? ""}</div>
    <div class="channels-wizard__footer">
      <button type="button" class="btn" @click=${() => props.onAnswer(false)}>
        ${t("common.no")}
      </button>
      <button type="button" class="btn primary" @click=${() => props.onAnswer(true)}>
        ${t("common.yes")}
      </button>
    </div>
  `;
}

function renderStepBody(step: ChannelWizardStep, props: ChannelWizardViewProps) {
  switch (step.type) {
    case "select":
      return renderSelectStep(step, props);
    case "multiselect":
      return renderMultiselectStep(step, props);
    case "text":
      return renderTextStep(step, props);
    case "confirm":
      return renderConfirmStep(step, props);
    default:
      return renderNoteStep(step, props);
  }
}

function renderWhatsAppLinking(props: ChannelWizardViewProps) {
  const connected = props.whatsappConnected === true;
  return html`
    <div class="channels-wizard__message">
      ${connected ? t("channels.setup.whatsappLinked") : t("channels.setup.whatsappScanTitle")}
    </div>
    ${props.whatsappMessage
      ? html`<div class="channels-wizard__note">${props.whatsappMessage}</div>`
      : nothing}
    ${connected
      ? nothing
      : html`
          <div class="channels-wizard__qr">
            ${props.whatsappQrDataUrl
              ? html`<img src=${props.whatsappQrDataUrl} alt="WhatsApp pairing QR code" />`
              : html`<div class="channels-wizard__spinner">
                  ${props.whatsappBusy
                    ? t("channels.setup.whatsappQrLoading")
                    : t("channels.setup.whatsappQrHint")}
                </div>`}
          </div>
          <div class="channels-wizard__note">${t("channels.setup.whatsappScanHelp")}</div>
        `}
    <div class="channels-wizard__footer">
      ${connected
        ? html`
            <button type="button" class="btn primary" @click=${() => props.onClose()}>
              ${t("channels.setup.finish")}
            </button>
          `
        : html`
            <button
              type="button"
              class="btn"
              ?disabled=${props.whatsappBusy}
              @click=${() => props.onWhatsAppStart(true)}
            >
              ${props.whatsappQrDataUrl ? t("channels.setup.regenerateQr") : t("common.showQr")}
            </button>
            ${props.whatsappQrDataUrl
              ? html`
                  <button
                    type="button"
                    class="btn primary"
                    ?disabled=${props.whatsappBusy}
                    @click=${() => props.onWhatsAppWait()}
                  >
                    ${t("common.waitForScan")}
                  </button>
                `
              : nothing}
            <button type="button" class="btn" @click=${() => props.onClose()}>
              ${t("channels.setup.linkLater")}
            </button>
          `}
    </div>
  `;
}

function renderDoneBody(channels: readonly string[], props: ChannelWizardViewProps) {
  if (channels.includes("whatsapp")) {
    return renderWhatsAppLinking(props);
  }
  if (channels.length === 0) {
    return html`
      <div class="channels-wizard__message">${t("channels.setup.doneNoChangesTitle")}</div>
      <div class="channels-wizard__note">${t("channels.setup.doneNoChangesBody")}</div>
      <div class="channels-wizard__footer">
        <button type="button" class="btn primary" @click=${() => props.onClose()}>
          ${t("common.close")}
        </button>
      </div>
    `;
  }
  return html`
    <div class="channels-wizard__message">${t("channels.setup.doneTitle")}</div>
    <div class="channels-wizard__note">${t("channels.setup.doneBody")}</div>
    <div class="channels-wizard__footer">
      <button type="button" class="btn primary" @click=${() => props.onClose()}>
        ${t("channels.setup.finish")}
      </button>
    </div>
  `;
}

function renderHelperLinks(channel: string | null, step: ChannelWizardStep | null) {
  const links = [...(channel ? (channelHubMeta(channel).setupLinks ?? []) : [])];
  if (step?.externalUrl) {
    links.unshift({ label: t("channels.setup.openLink"), url: step.externalUrl });
  }
  if (channel) {
    links.push({ label: t("channels.setup.docs"), url: channelDocsUrl(channel) });
  }
  if (links.length === 0) {
    return nothing;
  }
  return html`
    <div class="channels-wizard__links">
      ${links.map(
        (link) => html`
          <a class="btn btn--sm" href=${link.url} target="_blank" rel="noreferrer noopener">
            ${link.label} ↗
          </a>
        `,
      )}
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
    body = html`<div class="channels-wizard__spinner">${t("channels.setup.starting")}</div>`;
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
      ${wizard.phase === "step" && wizard.validationError
        ? html`<div class="channels-wizard__error">${wizard.validationError}</div>`
        : nothing}
      ${renderStepBody(step, props)}
      ${wizard.phase === "step" && wizard.busy
        ? html`<div class="channels-wizard__spinner">${t("channels.setup.working")}</div>`
        : nothing}
    `;
  }

  return html`
    <openclaw-modal-dialog
      label=${t("channels.setup.dialogLabel", { channel: label })}
      @modal-cancel=${() => props.onClose()}
    >
      <div class="channels-wizard">
        <div class="channels-wizard__header">
          ${channel ? renderChannelArt(channel, label, "tile") : nothing}
          <div class="channels-wizard__heading">
            <h2>${t("channels.setup.title", { channel: label })}</h2>
            <div class="muted">${t("channels.setup.subtitle")}</div>
          </div>
        </div>
        <div class="channels-wizard__body">${renderHelperLinks(channel, step)} ${body}</div>
      </div>
    </openclaw-modal-dialog>
  `;
}
