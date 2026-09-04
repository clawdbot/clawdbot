import { html, nothing } from "lit";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export function renderPicker<Option extends PickerOption>(params: {
  value: string;
  options: readonly Option[];
  label: string;
  className?: string;
  disabled?: boolean;
  renderLeading?: (option: Option) => unknown;
  onChange: (value: string) => void;
}) {
  const options: readonly PickerOption[] = params.options.some(
    (option) => option.value === params.value,
  )
    ? params.options
    : [...params.options, { value: params.value, label: params.value }];
  const selected = params.options.find((option) => option.value === params.value);
  return html`<span class="workboard-picker">
    ${selected ? params.renderLeading?.(selected) : nothing}
    <select
      class=${`settings-select workboard-native-select ${params.className ?? ""}`}
      aria-label=${params.label}
      .value=${params.value}
      ?disabled=${params.disabled}
      @change=${(event: Event) => {
        // SAFETY: The change listener is attached directly to this native select element.
        params.onChange((event.currentTarget as HTMLSelectElement).value);
      }}
    >
      ${options.map(
        (option) => html`<option
          value=${option.value}
          title=${option.description ?? nothing}
          ?selected=${option.value === params.value}
          ?disabled=${option.disabled}
        >
          ${option.label}${option.description ? ` — ${option.description}` : ""}
        </option>`,
      )}
    </select></span
  >`;
}
