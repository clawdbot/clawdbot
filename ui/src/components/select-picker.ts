import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import "./web-awesome-select.ts";
import "../styles/select-picker.css";

type PickerOptionElement = HTMLElement & { label: string; value: string; disabled: boolean };
// wa-select keeps a private current-option pointer; arrow keys from the search
// input hand it the first visible match so navigation skips filtered rows.
type PickerSelectElement = HTMLElement & { setCurrentOption?: (option: Element) => void };
function pickerOptions(select: Element): PickerOptionElement[] {
  return [...select.querySelectorAll<PickerOptionElement>("wa-option")];
}

function visiblePickerOptions(select: Element): PickerOptionElement[] {
  return pickerOptions(select).filter((option) => !option.hidden && !option.disabled);
}

// Filtering only hides rows: toggling `disabled` would make wa-select drop the
// current selection while the query is open.
function filterPickerOptions(input: HTMLInputElement): void {
  const select = input.closest("wa-select");
  if (!select) {
    return;
  }
  const query = input.value.trim().toLocaleLowerCase();
  for (const option of pickerOptions(select)) {
    const haystack = `${option.label} ${option.value} ${option.textContent}`.toLocaleLowerCase();
    option.hidden = Boolean(query) && !haystack.includes(query);
  }
}

function resetPickerSearch(select: HTMLElement): void {
  const input = select.querySelector<HTMLInputElement>(".picker-select__search-input");
  if (input && input.value) {
    input.value = "";
    filterPickerOptions(input);
  }
}

function handlePickerSearchKeydown(event: KeyboardEvent): void {
  const input = event.currentTarget as HTMLInputElement;
  const select = input.closest<PickerSelectElement>("wa-select");
  if (!select) {
    return;
  }
  if (event.key === "Escape" && input.value) {
    input.value = "";
    filterPickerOptions(input);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    // wa-select commits options on mouseup, not click.
    visiblePickerOptions(select)[0]?.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, composed: true }),
    );
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const options = visiblePickerOptions(select);
    const target = event.key === "ArrowDown" ? options[0] : options.at(-1);
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      select.setCurrentOption?.(target);
    }
    return;
  }
  // wa-select's document keydown treats printable keys as type-to-select and
  // cancels them; keep typing inside the search box.
  if (event.key.length === 1 || event.key === "Backspace") {
    event.stopPropagation();
  }
}

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  labelStyle?: string;
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
  searchable?: boolean;
  onOpen?: () => void;
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => unknown;
};

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  // Web Awesome syncs the listbox to its trigger; keep a 138px label floor so
  // option text does not collapse to an ellipsis at phone widths, but never
  // exceed the host container (cron/channel grids legitimately shrink below it).
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
      style="width:100%;min-width:min(138px,100%)"
      title=${params.title ?? nothing}
      placeholder=${params.value === null ? params.label : nothing}
      placement=${params.placement ?? nothing}
      .value=${params.value}
      ?disabled=${params.disabled}
      @wa-show=${() => params.onOpen?.()}
      @wa-after-show=${(event: Event) =>
        (event.currentTarget as HTMLElement)
          .querySelector<HTMLInputElement>(".picker-select__search-input")
          ?.focus()}
      @wa-after-hide=${(event: Event) => resetPickerSearch(event.currentTarget as HTMLElement)}
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
      ${params.searchable
        ? html`<div class="picker-select__search">
            <input
              class="picker-select__search-input"
              type="search"
              autocomplete="off"
              spellcheck="false"
              placeholder=${t("common.search")}
              aria-label=${t("common.search")}
              @input=${(event: InputEvent) =>
                filterPickerOptions(event.currentTarget as HTMLInputElement)}
              @keydown=${handlePickerSearchKeydown}
            />
          </div>`
        : nothing}
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
              <span class="picker-select__label" style=${option.labelStyle ?? nothing}
                >${option.label}</span
              >
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
