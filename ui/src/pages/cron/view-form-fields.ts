import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { renderChannelPicker } from "../../components/channel-picker.ts";
import { renderPicker, type PickerOption } from "../../components/select-picker.ts";
import { renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CronFieldKey, CronFormState } from "../../lib/cron/index.ts";
import type { CronProps } from "./view.ts";

export function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: string) {
  return `cron-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${t(message)}</div>`;
}

function renderRequiredTitle(label: string) {
  return html`
    ${label}
    <span class="cron-required-marker" aria-hidden="true">*</span>
    <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
  `;
}

export function renderFieldRow(params: {
  label: string;
  controlId: string;
  control: unknown;
  required?: boolean;
  help?: string;
  error?: string;
  errorId?: string;
  stacked?: boolean;
  wide?: boolean;
}) {
  const controlClass = params.wide ? "cron-control cron-control--wide" : "cron-control";
  const control = params.error
    ? html`<div class=${controlClass}>
        ${params.control}${renderFieldError(params.error, params.errorId)}
      </div>`
    : html`<div class=${controlClass}>${params.control}</div>`;
  return html`
    <div class=${params.stacked ? "settings-row settings-row--stacked" : "settings-row"}>
      <label class="settings-row__text" for=${ifDefined(params.controlId || undefined)}>
        <span class="settings-row__title">
          ${params.required ? renderRequiredTitle(params.label) : params.label}
        </span>
        ${params.help ? html`<span class="settings-row__desc">${params.help}</span>` : nothing}
      </label>
      <div class="settings-row__control">${control}</div>
    </div>
  `;
}

type CronStringFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends string ? Field : never;
}[keyof CronFormState];

type CronBooleanFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends boolean ? Field : never;
}[keyof CronFormState];

type CronInputOptions = {
  label: string;
  help?: string;
  placeholder?: string;
  list?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  mono?: boolean;
  errorKey?: CronFieldKey;
  describeError?: boolean;
};

export function renderCronInput(
  props: CronProps,
  field: CronStringFormField,
  options: CronInputOptions,
) {
  const error = options.errorKey ? props.fieldErrors[options.errorKey] : undefined;
  const describedBy =
    error && options.errorKey && options.describeError !== false
      ? errorIdForField(options.errorKey)
      : undefined;
  return html`
    <input
      id=${inputIdForField(field)}
      class=${options.mono ? "settings-input mono" : "settings-input"}
      type=${ifDefined(options.type)}
      aria-required=${ifDefined(options.required ? "true" : undefined)}
      .value=${props.form[field]}
      list=${ifDefined(options.list)}
      ?disabled=${options.disabled ?? false}
      aria-invalid=${ifDefined(options.errorKey ? (error ? "true" : "false") : undefined)}
      aria-describedby=${ifDefined(describedBy)}
      placeholder=${ifDefined(options.placeholder)}
      @input=${(event: Event) =>
        props.onFormChange({ [field]: (event.currentTarget as HTMLInputElement).value })}
    />
  `;
}

export function renderCronInputField(
  props: CronProps,
  field: CronStringFormField,
  options: CronInputOptions,
) {
  const errorKey = options.errorKey;
  return renderFieldRow({
    label: options.label,
    controlId: inputIdForField(field),
    required: options.required,
    help: options.help,
    error: errorKey ? props.fieldErrors[errorKey] : undefined,
    errorId: errorKey ? errorIdForField(errorKey) : undefined,
    control: renderCronInput(props, field, options),
  });
}

type CronSelectOptions = {
  label: string;
  options: readonly PickerOption[];
  help?: string;
  value?: string;
  disabled?: boolean;
  standalone?: boolean;
  channel?: boolean;
};

export function renderCronSelect(
  props: CronProps,
  field: CronStringFormField,
  options: CronSelectOptions,
) {
  const selected = options.value ?? props.form[field];
  const picker = options.channel ? renderChannelPicker : renderPicker;
  return picker({
    id: options.standalone ? undefined : inputIdForField(field),
    label: options.label,
    value: options.channel ? selected || "last" : selected,
    options: options.options,
    disabled: options.disabled,
    onChange: (value) => props.onFormChange({ [field]: value }),
  });
}

export function renderCronSelectField(
  props: CronProps,
  field: CronStringFormField,
  options: CronSelectOptions,
) {
  return renderFieldRow({
    label: options.label,
    controlId: inputIdForField(field),
    help: options.help,
    control: renderCronSelect(props, field, options),
  });
}

export function renderToggleRow(
  props: CronProps,
  field: CronBooleanFormField,
  params: { label: string; help?: string },
) {
  return renderSettingsToggleRow({
    title: params.label,
    description: params.help,
    checked: props.form[field],
    onChange: (checked) => props.onFormChange({ [field]: checked }),
  });
}
