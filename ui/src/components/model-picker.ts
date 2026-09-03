import { html, nothing } from "lit";
import { renderProviderBrandIcon } from "./provider-icon.ts";
import { renderPicker } from "./select-picker.ts";

export type ModelPickerOption = {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
  disabled?: boolean;
};

type ModelPickerParams = {
  id?: string;
  label: string;
  value: string;
  options: readonly ModelPickerOption[];
  disabled?: boolean;
  title?: string;
  className?: string;
  placement?: "top" | "bottom";
  custom?: {
    label: string;
    placeholder?: string;
    commit?: "input" | "change";
    id?: string;
    invalid?: boolean;
    describedBy?: string;
  };
  onOpen?: () => void;
  onChange: (value: string) => void;
};

// A search row earns its space once the list outgrows one listbox screen.
const SEARCHABLE_OPTION_FLOOR = 8;

export function renderModelPicker(params: ModelPickerParams) {
  let customValue = "__openclaw_custom_model__";
  const values = new Set([params.value, ...params.options.map((option) => option.value)]);
  while (values.has(customValue)) {
    customValue += "_";
  }
  const currentIsKnown = params.options.some((option) => option.value === params.value);
  const options: Array<ModelPickerOption & { description?: string }> = [
    ...params.options.map((option) => ({ ...option, description: option.detail })),
    ...(params.custom ? [{ value: customValue, label: params.custom.label }] : []),
  ];
  return html`
    <div class="model-picker">
      ${renderPicker({
        id: params.id,
        label: params.label,
        value: params.value,
        options,
        disabled: params.disabled,
        title: params.title,
        placement: params.placement,
        className: `model-picker__select ${params.className ?? ""}`,
        searchable: options.length > SEARCHABLE_OPTION_FLOOR,
        onOpen: params.onOpen,
        renderLeading: (option) =>
          option.provider
            ? renderProviderBrandIcon(option.provider, { className: "model-picker__provider-icon" })
            : nothing,
        onChange: params.onChange,
        onChangeTarget: (value, select) => {
          const wrapper = select.closest(".model-picker");
          const input = wrapper?.querySelector<HTMLInputElement>(".model-picker__custom");
          if (value === customValue && input) {
            input.hidden = false;
            queueMicrotask(() => input.focus());
            return;
          }
          if (input) {
            input.hidden = true;
          }
          params.onChange(value);
        },
      })}
      ${params.custom
        ? html`<input
            id=${params.custom.id ?? nothing}
            class="settings-input model-picker__custom"
            aria-label=${params.custom.label}
            aria-invalid=${params.custom.invalid ? "true" : "false"}
            aria-describedby=${params.custom.describedBy ?? nothing}
            placeholder=${params.custom.placeholder ?? ""}
            .value=${params.value}
            ?hidden=${currentIsKnown}
            ?disabled=${params.disabled}
            @input=${(event: InputEvent) => {
              if (params.custom?.commit !== "change") {
                params.onChange((event.currentTarget as HTMLInputElement).value);
              }
            }}
            @change=${(event: Event) => {
              if (params.custom?.commit === "change") {
                params.onChange((event.currentTarget as HTMLInputElement).value);
              }
            }}
          />`
        : nothing}
    </div>
  `;
}
