import { html, nothing } from "lit";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import "../../components/web-awesome-select.ts";

export type WorkboardSelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  boardId?: string;
  disabled?: boolean;
};

export function renderWorkboardSelect<Value extends string>(params: {
  value: Value;
  options: readonly WorkboardSelectOption<Value>[];
  label: string;
  onChange: (value: Value) => void;
  requestUpdate?: () => void;
  className?: string;
  showLabel?: boolean;
  disabled?: boolean;
}) {
  const selectedOption = params.options.find((option) => option.value === params.value);
  const select = html`
    <wa-select
      class="workboard-select ${params.className ?? ""}"
      label=${params.label}
      value=${params.value}
      ?disabled=${params.disabled}
      @change=${(event: Event) => {
        const value = (event.currentTarget as HTMLElement & { value?: string }).value as
          | Value
          | undefined;
        if (
          value !== undefined &&
          params.options.some((option) => option.value === value && !option.disabled)
        ) {
          params.onChange(value);
          params.requestUpdate?.();
        }
      }}
    >
      ${selectedOption?.boardId
        ? html`<span slot="start"
            >${renderWorkboardBoardGlyph({
              id: selectedOption.boardId,
              name: selectedOption.label,
              icon: selectedOption.icon,
              color: selectedOption.color,
            })}</span
          >`
        : nothing}
      ${params.options.map(
        (option) => html`
          <wa-option
            class="workboard-select__option"
            value=${option.value}
            .label=${option.label}
            ?selected=${option.value === params.value}
            ?disabled=${option.disabled}
          >
            ${option.boardId
              ? html`<span slot="start"
                  >${renderWorkboardBoardGlyph({
                    id: option.boardId,
                    name: option.label,
                    icon: option.icon,
                    color: option.color,
                  })}</span
                >`
              : nothing}
            <span class="workboard-select__copy">
              <span class="workboard-select__label">${option.label}</span>
              ${option.description
                ? html`<span class="workboard-select__description">${option.description}</span>`
                : nothing}
            </span>
          </wa-option>
        `,
      )}
    </wa-select>
  `;
  if (params.showLabel === false) {
    return select;
  }
  return html`
    <div class="workboard-field">
      <span>${params.label}</span>
      ${select}
    </div>
  `;
}
