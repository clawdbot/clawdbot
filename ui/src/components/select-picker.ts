import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import { icons } from "./icons.ts";
import "../styles/select-picker.css";

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

let pickerCount = 0;

function nextPickerId() {
  pickerCount += 1;
  return `openclaw-picker-${pickerCount}`;
}

export class SelectPicker<
  Option extends PickerOption = PickerOption,
> extends OpenClawLightDomElement {
  @property({ attribute: false }) params!: PickerParams<Option>;
  @state() private mode: "closed" | "compact" | "search" = "closed";
  @state() private query = "";
  @state() private activeValue: string | null = null;

  private readonly listboxId = nextPickerId();
  private typeahead = "";
  private typeaheadAt = 0;

  private options(): readonly Option[] {
    const { value, options } = this.params;
    return value === null || value === "" || options.some((option) => option.value === value)
      ? options
      : [...options, { value, label: value } as Option];
  }

  private rows(): readonly Option[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/u);
    return this.options().filter((option) => {
      const text = [option.label, option.value, option.description].join(" ").toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }

  private get trigger() {
    return this.querySelector<HTMLButtonElement>(".picker-select__trigger");
  }

  private closeMenu(restoreFocus = false) {
    this.mode = "closed";
    this.query = "";
    this.activeValue = null;
    this.typeahead = "";
    this.ownerDocument.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    // Tab's default action runs before Lit removes the panel's focus targets.
    this.querySelectorAll<HTMLElement>("[data-picker-focus]").forEach((element) => {
      element.tabIndex = -1;
    });
    if (restoreFocus) {
      this.trigger?.focus();
    }
  }

  private openMenu(last = false) {
    if (this.params.disabled || this.mode !== "closed") {
      return undefined;
    }
    this.mode = this.params.searchable && this.options().length > 8 ? "search" : "compact";
    const choices = this.rows().filter((option) => !option.disabled);
    this.activeValue =
      choices.find((option) => option.value === this.params.value)?.value ??
      (last ? choices.at(-1) : choices[0])?.value ??
      null;
    this.ownerDocument.addEventListener("pointerdown", this.handleOutsidePointer, true);
    this.params.onOpen?.();
    void this.updateComplete.then(() => {
      if (this.mode !== "closed") {
        this.querySelector<HTMLElement>("[data-picker-focus]")?.focus();
      }
    });
    return this.mode;
  }

  override disconnectedCallback() {
    this.closeMenu();
    super.disconnectedCallback();
  }

  protected override willUpdate() {
    if (this.params.disabled && this.mode !== "closed") {
      this.closeMenu();
    }
    if (this.mode !== "closed") {
      const choices = this.rows().filter((option) => !option.disabled);
      if (!choices.some((option) => option.value === this.activeValue)) {
        this.activeValue = choices[0]?.value ?? null;
      }
    }
  }

  protected override updated(changed: PropertyValues) {
    this.configurePopup();
    if (this.mode === "closed" || (!changed.has("activeValue") && !changed.has("query"))) {
      return;
    }
    const menu = this.querySelector<HTMLElement>(".picker-select__options");
    const active = menu?.querySelector<HTMLElement>("[data-active]");
    if (menu && active) {
      const bounds = menu.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.top < bounds.top) {
        menu.scrollTop -= bounds.top - row.top;
      } else if (row.bottom > bounds.bottom) {
        menu.scrollTop += row.bottom - bounds.bottom;
      }
    }
  }

  private commit(value: string | null) {
    const option = this.rows().find((row) => row.value === value);
    if (this.mode === "closed" || this.params.disabled || !option || option.disabled) {
      return;
    }
    this.closeMenu(true);
    if (this.params.onChangeTarget) {
      this.params.onChangeTarget(option.value, this);
    } else {
      this.params.onChange(option.value);
    }
  }

  private readonly handleOutsidePointer = (event: PointerEvent) => {
    if (!event.composedPath().includes(this)) {
      this.closeMenu();
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.contains(event.relatedTarget)) {
      this.closeMenu();
    }
  };

  private configurePopup() {
    const element = this.querySelector<WaPopup>("wa-popup");
    if (!(element instanceof WaPopup) || !this.trigger) {
      return;
    }
    configureAnchoredPopup(element, this.trigger, this.params.placement ?? "bottom");
    element.sync = "width";
  }

  private readonly handleKeydown = (event: KeyboardEvent) => {
    const editing = event.target instanceof HTMLInputElement;
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const opensMenu = ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key);
    if (this.mode === "closed" && !opensMenu && !printable) {
      return;
    }
    event.stopPropagation();
    if (event.isComposing || this.params.disabled) {
      return;
    }
    const now = performance.now();
    const typing = now - this.typeaheadAt < 1000 ? this.typeahead : "";
    if (this.mode === "closed") {
      if (opensMenu) {
        event.preventDefault();
        this.openMenu(event.key === "ArrowUp");
        return;
      }
      if (!printable) {
        return;
      }
      event.preventDefault();
      if (this.openMenu() === "search") {
        this.query = event.key;
        this.activeValue = null;
        return;
      }
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
      }
      this.closeMenu(true);
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !editing && !typing)) {
      event.preventDefault();
      this.commit(this.activeValue);
      return;
    }
    const choices = this.rows().filter((option) => !option.disabled);
    let index = choices.findIndex((option) => option.value === this.activeValue);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      index += event.key === "ArrowDown" ? 1 : -1;
      if (index < 0) {
        index = choices.length - 1;
      }
      if (index >= choices.length) {
        index = 0;
      }
    } else if (!editing && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      index = event.key === "Home" ? 0 : choices.length - 1;
    } else if (!editing && (printable || event.key === "Backspace")) {
      event.preventDefault();
      this.typeahead =
        event.key === "Backspace" ? typing.slice(0, -1) : typing + event.key.toLocaleLowerCase();
      this.typeaheadAt = now;
      index = choices.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(this.typeahead),
      );
    }
    const choice = choices[index];
    if (choice) {
      this.activeValue = choice.value;
    }
  };

  private leading(option: Option | undefined) {
    const content = option && this.params.renderLeading?.(option);
    return content === undefined || content === null || content === nothing
      ? nothing
      : html`<span class="picker-select__leading">${content}</span>`;
  }

  override render() {
    const rows = this.rows();
    const selected = this.options().find((option) => option.value === this.params.value);
    const active = rows.findIndex((option) => option.value === this.activeValue);
    const open = this.mode !== "closed";
    return html`
      <div @focusout=${this.handleFocusOut} @keydown=${this.handleKeydown}>
        <button
          id=${this.params.id ?? nothing}
          class="picker-select__trigger"
          type="button"
          aria-label=${selected ? `${this.params.label}: ${selected.label}` : this.params.label}
          aria-haspopup="listbox"
          aria-expanded=${String(open)}
          aria-controls=${this.listboxId}
          title=${this.params.title ?? nothing}
          ?disabled=${this.params.disabled}
          @click=${() => (open ? this.closeMenu() : this.openMenu())}
        >
          ${this.leading(selected)}
          <span class="picker-select__label">${selected?.label ?? this.params.label}</span>
          <span class="picker-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </button>
        <wa-popup ?active=${open}>
          <div class="picker-select__menu">
            ${
              this.mode === "search"
                ? html` <input
                    class="picker-select__search settings-input"
                    type="search"
                    role="combobox"
                    data-picker-focus
                    tabindex="0"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label=${t("common.search")}
                    placeholder=${t("common.search")}
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls=${this.listboxId}
                    aria-activedescendant=${active >= 0 ? `${this.listboxId}-${active}` : nothing}
                    .value=${live(this.query)}
                    @input=${(event: InputEvent) => {
                      this.query = (event.currentTarget as HTMLInputElement).value;
                      this.activeValue = null;
                    }}
                  />`
                : nothing
            }
            <div
              class="picker-select__options"
              role="listbox"
              id=${this.listboxId}
              aria-label=${this.params.label}
              ?data-picker-focus=${this.mode === "compact"}
              tabindex=${this.mode === "compact" ? 0 : -1}
              aria-activedescendant=${this.mode === "compact" && active >= 0 ? `${this.listboxId}-${active}` : nothing}
            >
              ${rows.map(
                (option, index) => html`
                  <div
                    class="picker-select__option"
                    role="option"
                    id=${`${this.listboxId}-${index}`}
                    data-value=${option.value}
                    title=${option.value}
                    aria-selected=${String(option.value === this.params.value)}
                    aria-disabled=${String(Boolean(option.disabled))}
                    ?data-active=${option.value === this.activeValue}
                    @mousedown=${(event: MouseEvent) => event.preventDefault()}
                    @mousemove=${() => {
                      if (!option.disabled) {
                        this.activeValue = option.value;
                      }
                    }}
                    @click=${() => this.commit(option.value)}
                  >
                    ${this.leading(option)}
                    <span class="picker-select__copy">
                      <span class="picker-select__label" style=${option.labelStyle ?? nothing}
                        >${option.label}</span
                      >
                      ${option.description ? html`<span class="picker-select__description">${option.description}</span>` : nothing}
                    </span>
                    <span class="picker-select__check" aria-hidden="true"
                      >${option.value === this.params.value ? icons.check : nothing}</span
                    >
                  </div>
                `,
              )}
            </div>
            <div class="picker-select__empty" role="status" ?hidden=${rows.length > 0}>
              ${t("common.pickerNoMatches")}
            </div>
          </div>
        </wa-popup>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-select-picker")) {
  customElements.define("openclaw-select-picker", SelectPicker);
}

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  return html`<openclaw-select-picker
    class=${`settings-select picker-select ${params.className ?? ""}`}
    style="width:100%;min-width:min(138px,100%)"
    .params=${params}
  ></openclaw-select-picker>`;
}
