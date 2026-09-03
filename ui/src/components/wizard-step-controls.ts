import { html, nothing, type TemplateResult } from "lit";
import type { WizardStep } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { renderChannelPicker } from "./channel-picker.ts";
import { handleCopyButton } from "./copy-button.ts";
import { renderPicker } from "./select-picker.ts";
import { renderSensitiveInput } from "./sensitive-input.ts";
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
  onAnswer: (value: unknown) => void;
  presentation?: "channels";
  channelSelect?: boolean;
  answerLabel?: string;
  busyLabel?: string;
  confirmAffirmativeLabel?: string;
  leadingAction?: TemplateResult;
  sensitiveRevealed?: boolean;
  onToggleSensitiveVisibility?: () => void;
};

export function renderWizardBusyButton(
  statusLabel: string,
  buttonLabel = t("modelSetup.wizard.continue"),
) {
  return html`
    <button type="button" class="btn primary" disabled aria-busy="true" aria-label=${buttonLabel}>
      <span class="btn__label">${buttonLabel}</span>
      <span class="btn__spinner" aria-hidden="true"></span>
      <span class="sr-only" role="status" aria-live="polite">${statusLabel}</span>
    </button>
  `;
}

function stepClass(props: WizardStepControlsProps, name: string): string {
  return `${props.presentation === "channels" ? "channels-wizard" : "wizard-step"}__${name}`;
}

function renderMessage(props: WizardStepControlsProps) {
  return props.step.message
    ? html`<div class=${stepClass(props, "message")}>
        ${formatUiExternalText(props.step.message)}
      </div>`
    : nothing;
}

function renderOptionBody(option: WizardStepOption, presentation?: "channels", selected?: boolean) {
  if (presentation === "channels") {
    return html`
      <span class="channels-wizard__option-label">
        ${selected === undefined ? nothing : selected ? "☑ " : "☐ "}${option.label}
      </span>
      ${option.hint
        ? html`<span class="channels-wizard__option-hint">${option.hint}</span>`
        : nothing}
    `;
  }
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
  const copyLabel = t("modelSetup.wizard.copy");
  return html`
    <div class="wizard-step__device-code">
      ${deviceCode.message
        ? html`<div class="muted">${formatUiExternalText(deviceCode.message)}</div>`
        : nothing}
      <code>${deviceCode.code}</code>
      <button
        type="button"
        class="btn btn--sm"
        @click=${(event: Event) => void handleCopyButton(event, deviceCode.code, copyLabel)}
      >
        <span data-copy-label>${copyLabel}</span>
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

function renderAnswerButton(
  props: WizardStepControlsProps,
  label: string,
  onClick?: () => void,
  disabled = props.busy,
) {
  const buttonLabel = props.answerLabel ?? label;
  if (props.presentation === "channels" && props.busy) {
    return html`<div class="channels-wizard__footer">
      ${renderWizardBusyButton(props.busyLabel ?? buttonLabel)}
    </div>`;
  }
  const button = html`
    <button
      type=${onClick ? "button" : "submit"}
      class="btn primary"
      ?disabled=${disabled}
      @click=${onClick}
    >
      ${buttonLabel}
    </button>
  `;
  if (props.presentation === "channels") {
    return html`<div class="channels-wizard__footer">${button}</div>`;
  }
  return props.leadingAction
    ? html`<div class="wizard-step__actions wizard-step__actions--split">
        ${props.leadingAction}${button}
      </div>`
    : button;
}

function renderOption(
  props: WizardStepControlsProps,
  option: WizardStepOption,
  selected: unknown[],
) {
  const checked = selected.some((value) => Object.is(value, option.value));
  if (props.presentation === "channels") {
    return html`<button
      type="button"
      class="channels-wizard__option"
      aria-pressed=${checked ? "true" : "false"}
      ?disabled=${props.busy}
      @click=${() => props.onValueChange(option.value)}
    >
      ${renderOptionBody(option, props.presentation, checked)}
    </button>`;
  }
  return html`<label class="wizard-step__option">
    <input
      type=${props.step.type === "select" ? "radio" : "checkbox"}
      name=${props.step.type === "select" ? `${props.inputId}-option` : nothing}
      .checked=${checked}
      ?disabled=${props.busy}
      @change=${(event: Event) => {
        const nextValue =
          props.step.type === "select"
            ? option.value
            : (event.currentTarget as HTMLInputElement).checked
              ? [...selected, option.value]
              : selected.filter((value) => !Object.is(value, option.value));
        props.onValueChange(nextValue);
      }}
    />
    ${renderOptionBody(option)}
  </label>`;
}

function renderExternalStepInfo(step: WizardStep) {
  return html`
    ${step.externalUrl
      ? html`<a
          class="btn btn--sm wizard-step__external-link"
          href=${step.externalUrl}
          target="_blank"
          rel="noreferrer"
        >
          ${t("modelSetup.wizard.openSignIn")}
        </a>`
      : nothing}
    ${renderDeviceCode(step)}
  `;
}

function renderContinueStep(props: WizardStepControlsProps) {
  return html`
    ${renderMessage(props)} ${renderExternalStepInfo(props.step)}
    ${renderAnswerButton(props, t("modelSetup.wizard.continue"), () => props.onAnswer(undefined))}
  `;
}

function renderProgressStep(props: WizardStepControlsProps) {
  return html`
    <div class="wizard-step__progress" role="status" aria-live="polite">
      <span class="wizard-step__spinner" aria-hidden="true"></span>
      ${renderMessage(props)}
    </div>
    ${props.leadingAction
      ? html`<div class="wizard-step__actions wizard-step__actions--split">
          ${props.leadingAction}
        </div>`
      : nothing}
  `;
}

function renderTextStep(props: WizardStepControlsProps) {
  const step = props.step;
  const value = typeof props.value === "string" ? props.value : "";
  const input =
    step.sensitive && props.onToggleSensitiveVisibility
      ? renderSensitiveInput({
          id: props.inputId,
          name: "wizard-text",
          value,
          revealed: props.sensitiveRevealed === true,
          revealLabel: t("configForm.revealValue"),
          hideLabel: t("configForm.hideValue"),
          inputClassName: "input",
          placeholder: step.placeholder,
          disabled: props.busy,
          onInput: props.onValueChange,
          onToggle: props.onToggleSensitiveVisibility,
        })
      : html`<input
          id=${props.inputId}
          class="input"
          name="wizard-text"
          type=${step.sensitive ? "password" : "text"}
          autocomplete=${step.sensitive ? "off" : "on"}
          placeholder=${step.placeholder ?? ""}
          .value=${value}
          ?disabled=${props.busy}
          @input=${(event: Event) =>
            props.presentation !== "channels" &&
            props.onValueChange((event.currentTarget as HTMLInputElement).value)}
        />`;
  return html`
    <form
      class="wizard-step__form"
      @submit=${(event: Event) => {
        event.preventDefault();
        const formInput = (event.currentTarget as HTMLFormElement).elements.namedItem(
          "wizard-text",
        ) as HTMLInputElement | null;
        props.onAnswer(props.presentation === "channels" ? (formInput?.value ?? "") : value);
      }}
    >
      ${step.message
        ? html`<div class=${stepClass(props, "message")}>
            <label for=${props.inputId}>${formatUiExternalText(step.message)}</label>
          </div>`
        : nothing}
      ${renderExternalStepInfo(step)} ${input}
      ${renderAnswerButton(props, t("modelSetup.wizard.submit"))}
    </form>
  `;
}

function renderOptionsStep(props: WizardStepControlsProps) {
  const options = props.step.options ?? [];
  const multiple = props.step.type === "multiselect";
  const selected = multiple ? (Array.isArray(props.value) ? props.value : []) : [props.value];
  if (props.presentation === "channels" && !multiple) {
    const selectedIndex = options.findIndex((option) => Object.is(option.value, props.value));
    const channels =
      props.channelSelect && options.every((option) => typeof option.value === "string");
    const picker = channels ? renderChannelPicker : renderPicker;
    return html`
      ${renderMessage(props)}
      ${picker({
        label: props.step.message ?? "",
        value:
          selectedIndex < 0
            ? null
            : channels
              ? String(options[selectedIndex]?.value)
              : String(selectedIndex),
        options: options.map((option, index) => ({
          value: channels ? String(option.value) : String(index),
          label: option.label,
          description: option.hint,
          kind: channels ? "channel" : "neutral",
        })),
        disabled: props.busy,
        onChange: (value) => props.onAnswer(channels ? value : options[Number(value)]?.value),
      })}
      ${props.busy
        ? renderAnswerButton(props, t("modelSetup.wizard.continue"), undefined, true)
        : nothing}
    `;
  }
  const answer = multiple
    ? props.presentation === "channels"
      ? [...selected]
      : selected
    : props.value;
  return html`
    ${renderMessage(props)}
    <div class=${stepClass(props, "options")} role=${multiple ? nothing : "radiogroup"}>
      ${options.map((option) => renderOption(props, option, selected))}
    </div>
    ${renderAnswerButton(
      props,
      t("modelSetup.wizard.continue"),
      () => props.onAnswer(answer),
      props.busy || (!multiple && props.value === undefined),
    )}
  `;
}

function renderConfirmStep(props: WizardStepControlsProps) {
  const actionClass = stepClass(props, props.presentation === "channels" ? "footer" : "actions");
  return html`
    ${renderMessage(props)}
    <div
      class=${props.presentation !== "channels" && props.leadingAction
        ? `${actionClass} wizard-step__actions--split`
        : actionClass}
    >
      ${props.presentation === "channels" ? nothing : (props.leadingAction ?? nothing)}
      ${props.presentation === "channels" && props.busy
        ? renderWizardBusyButton(props.busyLabel ?? t("common.loading"))
        : [false, true].map(
            (answer) => html`<button
              type="button"
              class=${answer ? "btn primary" : "btn"}
              ?disabled=${props.busy}
              @click=${() => props.onAnswer(answer)}
            >
              ${answer ? (props.confirmAffirmativeLabel ?? t("common.yes")) : t("common.no")}
            </button>`,
          )}
    </div>
  `;
}

/**
 * Renders the interactive controls for one `WizardStep`. Container-agnostic on
 * purpose: no dialog chrome or page state — callers place the result wherever
 * the step is being asked (modal, panel, or chat bubble). A caller may supply a
 * leading action so escape and answer controls share one footer row.
 */
export function renderWizardStepControls(
  props: WizardStepControlsProps,
): TemplateResult | typeof nothing {
  switch (props.step.type) {
    case "text":
      return renderTextStep(props);
    case "select":
    case "multiselect":
      return renderOptionsStep(props);
    case "confirm":
      return renderConfirmStep(props);
    case "progress":
      return props.step.executor === "gateway"
        ? renderProgressStep(props)
        : renderContinueStep(props);
    // These show whatever the step supplies behind a single Continue.
    case "note":
    case "action":
      return renderContinueStep(props);
  }
  return nothing;
}
