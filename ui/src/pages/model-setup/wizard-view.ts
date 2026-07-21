import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import type { ModelSetupWizardState } from "./state.ts";

type WizardViewProps = {
  state: ModelSetupWizardState;
  value: unknown;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown, includeValue?: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
};

function renderDeviceCode(step: Extract<ModelSetupWizardState, { phase: "step" }>["step"]) {
  if (!step.deviceCode) {
    return nothing;
  }
  return html`
    <div class="model-setup-wizard__device-code">
      ${step.deviceCode.message
        ? html`<div class="muted">${step.deviceCode.message}</div>`
        : nothing}
      <code>${step.deviceCode.code}</code>
      <button
        type="button"
        class="btn btn--sm"
        @click=${() => void copyToClipboard(step.deviceCode!.code)}
      >
        ${t("modelSetup.wizard.copy")}
      </button>
      ${step.deviceCode.expiresInMinutes
        ? html`<div class="muted">
            ${t("modelSetup.wizard.expires", {
              count: String(step.deviceCode.expiresInMinutes),
            })}
          </div>`
        : nothing}
    </div>
  `;
}

function renderContinueStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  const step = props.state.step;
  return html`
    ${step.message ? html`<div class="model-setup-wizard__message">${step.message}</div>` : nothing}
    ${step.externalUrl
      ? html`<a class="btn btn--sm" href=${step.externalUrl} target="_blank" rel="noreferrer">
          ${t("modelSetup.wizard.openSignIn")}
        </a>`
      : nothing}
    ${renderDeviceCode(step)}
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.state.busy}
      @click=${() => props.onAnswer(undefined, false)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

function renderTextStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  const step = props.state.step;
  return html`
    <form
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onAnswer(typeof props.value === "string" ? props.value : "");
      }}
    >
      ${step.message
        ? html`<div class="model-setup-wizard__message">
            <label for="model-setup-wizard-text-input">${step.message}</label>
          </div>`
        : nothing}
      <input
        id="model-setup-wizard-text-input"
        class="input"
        name="wizard-text"
        type=${step.sensitive ? "password" : "text"}
        autocomplete=${step.sensitive ? "off" : "on"}
        placeholder=${step.placeholder ?? ""}
        .value=${typeof props.value === "string" ? props.value : ""}
        ?disabled=${props.state.busy}
        @input=${(event: Event) =>
          props.onValueChange((event.currentTarget as HTMLInputElement).value)}
      />
      <button type="submit" class="btn primary" ?disabled=${props.state.busy}>
        ${t("modelSetup.wizard.submit")}
      </button>
    </form>
  `;
}

function renderSelectStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  const step = props.state.step;
  return html`
    ${step.message ? html`<div class="model-setup-wizard__message">${step.message}</div>` : nothing}
    <div class="model-setup-wizard__options" role="radiogroup">
      ${(step.options ?? []).map(
        (option) => html`
          <label class="model-setup-wizard__option">
            <input
              type="radio"
              name="wizard-option"
              .checked=${Object.is(props.value, option.value)}
              @change=${() => props.onValueChange(option.value)}
            />
            <span>
              <strong>${option.label}</strong>
              ${option.hint ? html`<small>${option.hint}</small>` : nothing}
            </span>
          </label>
        `,
      )}
    </div>
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.state.busy || props.value === undefined}
      @click=${() => props.onAnswer(props.value)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

function renderConfirmStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  return html`
    ${props.state.step.message
      ? html`<div class="model-setup-wizard__message">${props.state.step.message}</div>`
      : nothing}
    <div class="model-setup-wizard__actions">
      <button
        type="button"
        class="btn"
        ?disabled=${props.state.busy}
        @click=${() => props.onAnswer(false)}
      >
        ${t("common.no")}
      </button>
      <button
        type="button"
        class="btn primary"
        ?disabled=${props.state.busy}
        @click=${() => props.onAnswer(true)}
      >
        ${t("common.yes")}
      </button>
    </div>
  `;
}

function renderMultiselectStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  const selected = Array.isArray(props.value) ? props.value : [];
  return html`
    ${props.state.step.message
      ? html`<div class="model-setup-wizard__message">${props.state.step.message}</div>`
      : nothing}
    <div class="model-setup-wizard__options">
      ${(props.state.step.options ?? []).map(
        (option) => html`
          <label class="model-setup-wizard__option">
            <input
              type="checkbox"
              .checked=${selected.some((value) => Object.is(value, option.value))}
              @change=${(event: Event) => {
                const checked = (event.currentTarget as HTMLInputElement).checked;
                props.onValueChange(
                  checked
                    ? [...selected, option.value]
                    : selected.filter((value) => !Object.is(value, option.value)),
                );
              }}
            />
            <span>
              <strong>${option.label}</strong>
              ${option.hint ? html`<small>${option.hint}</small>` : nothing}
            </span>
          </label>
        `,
      )}
    </div>
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.state.busy}
      @click=${() => props.onAnswer(selected)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

function renderStep(props: WizardViewProps) {
  if (props.state.phase !== "step") {
    return nothing;
  }
  switch (props.state.step.type) {
    case "text":
      return renderTextStep(props);
    case "select":
      return renderSelectStep(props);
    case "confirm":
      return renderConfirmStep(props);
    case "multiselect":
      return renderMultiselectStep(props);
    case "note":
    case "progress":
    case "action":
      return renderContinueStep(props);
  }
  return nothing;
}

export function renderModelSetupWizard(props: WizardViewProps): TemplateResult | typeof nothing {
  if (props.state.phase === "idle") {
    return nothing;
  }
  const canCancel =
    props.state.phase === "starting" ||
    props.state.phase === "step" ||
    props.state.phase === "done";
  return html`
    <openclaw-modal-dialog
      label=${t("modelSetup.wizard.dialogLabel")}
      @modal-cancel=${canCancel ? props.onCancel : props.onClose}
    >
      <div class="model-setup-wizard">
        <div class="model-setup-wizard__header">
          <h2>
            ${props.state.phase === "step" && props.state.step.title
              ? props.state.step.title
              : t("modelSetup.wizard.title")}
          </h2>
        </div>
        <div class="model-setup-wizard__body">
          ${props.state.phase === "starting"
            ? html`<div role="status">${t("modelSetup.wizard.starting")}</div>`
            : props.state.phase === "done"
              ? html`<div role="status">${t("modelSetup.wizard.checking")}</div>`
              : props.state.phase === "error" || props.state.phase === "cancelled"
                ? html`<div class="callout danger" role="alert">${props.state.message}</div>`
                : html`
                    ${props.state.validationError
                      ? html`<div class="callout danger" role="alert">
                          ${props.state.validationError}
                        </div>`
                      : nothing}
                    ${renderStep(props)}
                    ${props.state.busy
                      ? html`<div role="status">${t("modelSetup.wizard.working")}</div>`
                      : nothing}
                  `}
        </div>
        <div class="model-setup-wizard__footer">
          <button type="button" class="btn" @click=${canCancel ? props.onCancel : props.onClose}>
            ${canCancel ? t("common.cancel") : t("common.close")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
