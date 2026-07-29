import { html, nothing, type TemplateResult } from "lit";
import type { WizardStep } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import "../styles/wizard-step-controls.css";

type WizardStepOption = NonNullable<WizardStep["options"]>[number];

type WizardStepControlsProps = {
  step: WizardStep;
  /** Current draft answer; owned by the caller so it survives re-renders. */
  value: unknown;
  /** Disables every control while an answer is in flight. */
  busy: boolean;
  // The text step pairs `<label for>` with `<input id>`. The caller owns the id
  // so two step controls in one document cannot capture each other's label.
  inputId: string;
  onValueChange: (value: unknown) => void;
  onAnswer: (value: unknown, includeValue?: boolean) => void;
};

function renderMessage(step: WizardStep) {
  return step.message ? html`<div class="wizard-step__message">${step.message}</div>` : nothing;
}

function renderOptionBody(option: WizardStepOption) {
  return html`
    <span>
      <strong>${option.label}</strong>
      ${option.hint ? html`<small>${option.hint}</small>` : nothing}
    </span>
  `;
}

function renderDeviceCode(step: WizardStep) {
  const deviceCode = step.deviceCode;
  if (!deviceCode) {
    return nothing;
  }
  return html`
    <div class="wizard-step__device-code">
      ${deviceCode.message ? html`<div class="muted">${deviceCode.message}</div>` : nothing}
      <code>${deviceCode.code}</code>
      <button
        type="button"
        class="btn btn--sm"
        @click=${() => void copyToClipboard(deviceCode.code)}
      >
        ${t("modelSetup.wizard.copy")}
      </button>
      ${deviceCode.expiresInMinutes
        ? html`<div class="muted">
            ${t("modelSetup.wizard.expires", {
              count: String(deviceCode.expiresInMinutes),
            })}
          </div>`
        : nothing}
    </div>
  `;
}

function renderContinueStep(props: WizardStepControlsProps) {
  const step = props.step;
  return html`
    ${renderMessage(step)}
    ${step.externalUrl
      ? html`<a class="btn btn--sm" href=${step.externalUrl} target="_blank" rel="noreferrer">
          ${t("modelSetup.wizard.openSignIn")}
        </a>`
      : nothing}
    ${renderDeviceCode(step)}
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.busy}
      @click=${() => props.onAnswer(undefined, false)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

function renderTextStep(props: WizardStepControlsProps) {
  const step = props.step;
  const value = typeof props.value === "string" ? props.value : "";
  return html`
    <form
      class="wizard-step__form"
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onAnswer(value);
      }}
    >
      ${step.message
        ? html`<div class="wizard-step__message">
            <label for=${props.inputId}>${step.message}</label>
          </div>`
        : nothing}
      <input
        id=${props.inputId}
        class="input"
        name="wizard-text"
        type=${step.sensitive ? "password" : "text"}
        autocomplete=${step.sensitive ? "off" : "on"}
        placeholder=${step.placeholder ?? ""}
        .value=${value}
        ?disabled=${props.busy}
        @input=${(event: Event) =>
          props.onValueChange((event.currentTarget as HTMLInputElement).value)}
      />
      <button type="submit" class="btn primary" ?disabled=${props.busy}>
        ${t("modelSetup.wizard.submit")}
      </button>
    </form>
  `;
}

function renderSelectStep(props: WizardStepControlsProps) {
  return html`
    ${renderMessage(props.step)}
    <div class="wizard-step__options" role="radiogroup">
      ${(props.step.options ?? []).map(
        (option) => html`
          <label class="wizard-step__option">
            <input
              type="radio"
              name="wizard-option"
              .checked=${Object.is(props.value, option.value)}
              @change=${() => props.onValueChange(option.value)}
            />
            ${renderOptionBody(option)}
          </label>
        `,
      )}
    </div>
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.busy || props.value === undefined}
      @click=${() => props.onAnswer(props.value)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

function renderConfirmStep(props: WizardStepControlsProps) {
  return html`
    ${renderMessage(props.step)}
    <div class="wizard-step__actions">
      <button
        type="button"
        class="btn"
        ?disabled=${props.busy}
        @click=${() => props.onAnswer(false)}
      >
        ${t("common.no")}
      </button>
      <button
        type="button"
        class="btn primary"
        ?disabled=${props.busy}
        @click=${() => props.onAnswer(true)}
      >
        ${t("common.yes")}
      </button>
    </div>
  `;
}

function renderMultiselectStep(props: WizardStepControlsProps) {
  const selected = Array.isArray(props.value) ? props.value : [];
  return html`
    ${renderMessage(props.step)}
    <div class="wizard-step__options">
      ${(props.step.options ?? []).map(
        (option) => html`
          <label class="wizard-step__option">
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
            ${renderOptionBody(option)}
          </label>
        `,
      )}
    </div>
    <button
      type="button"
      class="btn primary"
      ?disabled=${props.busy}
      @click=${() => props.onAnswer(selected)}
    >
      ${t("modelSetup.wizard.continue")}
    </button>
  `;
}

/**
 * Renders the interactive controls for one `WizardStep`. Container-agnostic on
 * purpose: no dialog chrome, no cancel row, no page state — callers place the
 * result wherever the step is being asked (modal, panel, or chat bubble).
 */
export function renderWizardStepControls(
  props: WizardStepControlsProps,
): TemplateResult | typeof nothing {
  switch (props.step.type) {
    case "text":
      return renderTextStep(props);
    case "select":
      return renderSelectStep(props);
    case "confirm":
      return renderConfirmStep(props);
    case "multiselect":
      return renderMultiselectStep(props);
    // These carry no input of their own: they show whatever the step supplies
    // (message, link, device code) behind a single Continue.
    case "note":
    case "progress":
    case "action":
      return renderContinueStep(props);
  }
  return nothing;
}
