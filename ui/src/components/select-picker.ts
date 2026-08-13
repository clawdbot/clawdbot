import { html, nothing } from "lit";
import "./web-awesome-select.ts";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type PickerParams<Option extends PickerOption> = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly Option[];
  disabled?: boolean;
  className?: string;
  title?: string;
  placement?: "top" | "bottom";
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => unknown;
};

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  // Web Awesome syncs the listbox to its trigger; keep 8ch for the label after
  // its fixed check and leading-icon columns instead of collapsing the options.
  const options =
    params.value === null ||
    params.value === "" ||
    params.options.some((option) => option.value === params.value)
      ? params.options
      : [...params.options, { value: params.value, label: params.value } as Option];
  const leading = (option: Option | undefined) => {
    const content = option && params.renderLeading?.(option);
    return content === undefined || content === null || content === nothing
      ? nothing
      : html`<span slot="start">${content}</span>`;
  };
  return html`
    <wa-select
      id=${params.id ?? nothing}
      class=${`settings-select picker-select ${params.className ?? ""}`}
      style="width:100%;min-width:138px"
      title=${params.title ?? nothing}
      placement=${params.placement ?? nothing}
      .value=${params.value}
      ?disabled=${params.disabled}
      @change=${(event: Event) => {
        const value = (event.currentTarget as HTMLElement & { value?: unknown }).value;
        const option = typeof value === "string" && options.find((entry) => entry.value === value);
        if (option && !option.disabled) {
          if (params.onChangeTarget) {
            params.onChangeTarget(value, event.currentTarget as HTMLElement);
          } else {
            params.onChange(value);
          }
        }
      }}
    >
      <span slot="label" class="settings-control__sr-label">${params.label}</span>
      ${leading(options.find((option) => option.value === params.value))}
      ${options.map(
        (option) => html`
          <wa-option
            class="picker-select__option"
            value=${option.value}
            .label=${option.label}
            ?selected=${option.value === params.value}
            ?disabled=${option.disabled}
          >
            ${leading(option)}
            <span class="picker-select__copy">
              <span class="picker-select__label">${option.label}</span>
              ${option.description
                ? html`<span class="picker-select__description">${option.description}</span>`
                : nothing}
            </span>
          </wa-option>
        `,
      )}
    </wa-select>
  `;
}
