import { html, nothing } from "lit";
import { renderPicker, type PickerOption } from "../../components/select-picker.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";

export type WorkboardSelectOption<Value extends string = string> = PickerOption & {
  value: Value;
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
  const select = renderPicker({
    value: params.value,
    options: params.options,
    label: params.label,
    className: `workboard-select ${params.className ?? ""}`,
    disabled: params.disabled,
    renderLeading: (option) =>
      option.boardId
        ? renderWorkboardBoardGlyph({
            id: option.boardId,
            name: option.label,
            icon: option.icon,
            color: option.color,
          })
        : nothing,
    onChange: (value) => {
      params.onChange(value as Value);
      params.requestUpdate?.();
    },
  });
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
