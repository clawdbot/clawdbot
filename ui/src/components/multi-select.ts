// Multi-value combobox: the current values sit inside a full-width field as
// removable chips, the dropdown lists the remaining options filtered by what
// the operator types, and optional free-text entry appends values the option
// list does not know. Light DOM so the shared stylesheet applies.
import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { renderProviderBrandIcon } from "./provider-icon.ts";
import "../styles/multi-select.css";

export type MultiSelectOption = {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
};

type MultiSelectRow = MultiSelectOption & { custom?: boolean };

let instanceCounter = 0;

function nextListboxId(): string {
  instanceCounter += 1;
  return `openclaw-multi-select-${instanceCounter}`;
}

function providerFromValue(value: string): string | undefined {
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

const keepInputFocus = (event: Event) => event.preventDefault();

export class MultiSelect extends OpenClawLightDomElement {
  @property({ attribute: false }) options: readonly MultiSelectOption[] = [];
  /** Current values in display order. Controlled: the host owns them. */
  @property({ attribute: false }) value: readonly string[] = [];
  /** Values kept out of the dropdown without being chips, e.g. a primary model. */
  @property({ attribute: false }) exclude: readonly string[] = [];
  @property({ attribute: false }) placeholder = "";
  @property({ attribute: false }) accessibleLabel = "";
  /** Accept typed values, including comma-separated input, outside the option list. */
  @property({ attribute: false }) allowCustom = false;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) onChange: (value: string[]) => void = () => {};
  /** Runs when the dropdown opens, e.g. to refresh a catalog. */
  @property({ attribute: false }) onOpen: () => void = () => {};

  @state() private open = false;
  @state() private query = "";
  @state() private activeIndex = 0;

  private readonly listboxId = nextListboxId();
  private field: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("disabled") && this.disabled && this.open) {
      this.closeMenu();
    }
    if (this.open && (changed.has("options") || changed.has("value") || changed.has("exclude"))) {
      this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.rows().length - 1));
    }
  }

  protected override updated(changed: PropertyValues) {
    if (
      !this.open ||
      !["open", "query", "activeIndex", "options", "value", "exclude"].some((key) =>
        changed.has(key),
      )
    ) {
      return;
    }
    const menu = this.querySelector<HTMLElement>(".multi-select__menu");
    const option = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !option) {
      return;
    }
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = option.getBoundingClientRect();
    // Keep keyboard navigation inside this popup without scrolling the settings page.
    if (optionBounds.top < menuBounds.top) {
      menu.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  }

  private optionFor(value: string): MultiSelectOption | undefined {
    const key = value.toLowerCase();
    return this.options.find((option) => option.value.toLowerCase() === key);
  }

  /** Dropdown rows: unchosen options matching the query, then the custom entry. */
  private rows(): MultiSelectRow[] {
    const taken = new Set([...this.value, ...this.exclude].map((entry) => entry.toLowerCase()));
    const custom = this.query.trim();
    const query = custom.toLowerCase();
    const rows: MultiSelectRow[] = [];
    let exact: MultiSelectRow | null = null;
    for (const option of this.options) {
      const key = option.value.toLowerCase();
      if (taken.has(key)) {
        continue;
      }
      if (key === query) {
        exact = option;
        continue;
      }
      const haystack = [option.label, option.value, option.provider, option.detail];
      if (!query || haystack.some((text) => text?.toLowerCase().includes(query))) {
        rows.push(option);
      }
    }
    if (exact) {
      rows.unshift(exact);
    } else if (this.allowCustom && custom && !taken.has(query)) {
      rows.push({
        value: custom,
        label: custom,
        provider: providerFromValue(custom),
        custom: true,
      });
    }
    return rows;
  }

  private openMenu() {
    if (this.disabled || this.open) {
      return;
    }
    this.open = true;
    this.activeIndex = 0;
    this.onOpen();
  }

  private closeMenu() {
    this.open = false;
    this.query = "";
    this.activeIndex = 0;
  }

  private commit(values: readonly string[]) {
    if (this.disabled) {
      return;
    }
    const taken = new Set([...this.value, ...this.exclude].map((entry) => entry.toLowerCase()));
    const additions: string[] = [];
    for (const value of values) {
      const next = value.trim();
      const key = next.toLowerCase();
      if (next && !taken.has(key)) {
        taken.add(key);
        additions.push(next);
      }
    }
    if (additions.length > 0) {
      this.onChange([...this.value, ...additions]);
    }
    this.query = "";
    this.activeIndex = 0;
  }

  private commitTypedQuery() {
    const values = normalizeCsvOrLooseStringList(this.query).map(
      (value) => this.optionFor(value)?.value ?? value,
    );
    this.commit(values);
  }

  private selectRow(row: MultiSelectRow) {
    if (row.custom) {
      this.commitTypedQuery();
    } else {
      this.commit([row.value]);
    }
  }

  private removeAt(index: number) {
    if (this.disabled) {
      return;
    }
    this.onChange(this.value.filter((_, i) => i !== index));
    this.input?.focus();
  }

  private readonly setField = (element?: Element) => {
    this.field = element instanceof HTMLElement ? element : null;
  };

  private readonly setInput = (element?: Element) => {
    this.input = element instanceof HTMLInputElement ? element : null;
  };

  // Ref callbacks run in DOM order, so the field anchor exists by the time the
  // popup mounts. Positioning mirrors the shared anchored overlay tuning.
  private readonly configurePopup = (element?: Element) => {
    if (!(element instanceof WaPopup) || !this.field) {
      return;
    }
    const popup = element;
    popup.anchor = this.field;
    popup.placement = "bottom-start";
    popup.boundary = "viewport";
    popup.distance = 6;
    popup.flip = true;
    popup.flipPadding = 8;
    popup.shift = true;
    popup.shiftPadding = 12;
    popup.autoSize = "vertical";
    popup.autoSizePadding = 8;
    popup.sync = "width";
  };

  private readonly handleFieldClick = (event: MouseEvent) => {
    if (this.disabled || (event.target instanceof Element && event.target.closest("button"))) {
      return;
    }
    this.input?.focus();
    this.openMenu();
  };

  private readonly handleInput = (event: Event) => {
    if (!(event.currentTarget instanceof HTMLInputElement)) {
      return;
    }
    this.query = event.currentTarget.value;
    this.activeIndex = 0;
    this.openMenu();
  };

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (this.disabled || event.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!this.open) {
          this.openMenu();
          return;
        }
        const count = this.rows().length;
        if (count > 0) {
          const step = event.key === "ArrowDown" ? 1 : count - 1;
          this.activeIndex = (this.activeIndex + step) % count;
        }
        return;
      }
      case "Enter": {
        if (!this.open) {
          return;
        }
        const row = this.rows()[this.activeIndex];
        if (row) {
          event.preventDefault();
          this.selectRow(row);
        }
        return;
      }
      case ",":
        if (this.allowCustom) {
          event.preventDefault();
          this.commitTypedQuery();
        }
        return;
      case "Escape":
        if (this.open) {
          event.preventDefault();
          event.stopPropagation();
          this.closeMenu();
        }
        return;
      case "Backspace":
        if (!this.query && this.value.length > 0) {
          event.preventDefault();
          this.removeAt(this.value.length - 1);
        }
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.contains(next)) {
      return;
    }
    this.closeMenu();
  };

  private renderChip(value: string, index: number) {
    const option = this.optionFor(value);
    const provider = option?.provider ?? providerFromValue(value);
    const label = option?.label ?? value;
    return html`
      <span class="chip multi-select__chip" data-value=${value} title=${value}>
        ${
          provider
            ? renderProviderBrandIcon(provider, { className: "multi-select__chip-icon" })
            : nothing
        }
        <span class="multi-select__chip-label">${label}</span>
        <button
          type="button"
          class="chip-remove"
          aria-label=${t("common.multiSelect.remove", { value: label })}
          ?disabled=${this.disabled}
          @click=${() => this.removeAt(index)}
        >
          ${icons.x}
        </button>
      </span>
    `;
  }

  override render() {
    const rows = this.open ? this.rows() : [];
    const active = this.open && rows.length > 0 ? Math.min(this.activeIndex, rows.length - 1) : -1;
    const label = this.accessibleLabel || this.placeholder;
    return html`
      <div
        class=${this.open ? "multi-select multi-select--open" : "multi-select"}
        ?data-disabled=${this.disabled}
        @click=${this.handleFieldClick}
        @focusout=${this.handleFocusOut}
        ${ref(this.setField)}
      >
        ${this.value.map((value, index) => this.renderChip(value, index))}
        <input
          ${ref(this.setInput)}
          class="multi-select__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-label=${label}
          aria-expanded=${this.open ? "true" : "false"}
          aria-controls=${this.listboxId}
          aria-autocomplete="list"
          aria-activedescendant=${active >= 0 ? `${this.listboxId}-${active}` : nothing}
          placeholder=${this.value.length === 0 ? this.placeholder : ""}
          .value=${live(this.query)}
          ?disabled=${this.disabled}
          @input=${this.handleInput}
          @keydown=${this.handleKeydown}
        />
        <span class="multi-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </div>
      <wa-popup class="multi-select__popup" ?active=${this.open} ${ref(this.configurePopup)}>
        <div class="multi-select__menu" role="listbox" id=${this.listboxId} aria-label=${label}>
          ${rows.map(
            (row, index) => html`
              <div
                class="multi-select__option"
                role="option"
                id=${`${this.listboxId}-${index}`}
                aria-selected=${index === active ? "true" : "false"}
                data-value=${row.value}
                ?data-custom=${Boolean(row.custom)}
                @mousedown=${keepInputFocus}
                @mousemove=${() => {
                  if (this.activeIndex !== index) {
                    this.activeIndex = index;
                  }
                }}
                @click=${() => this.selectRow(row)}
              >
                ${
                  row.provider
                    ? renderProviderBrandIcon(row.provider, {
                        className: "multi-select__option-icon",
                      })
                    : nothing
                }
                <span class="picker-select__copy">
                  <span class="picker-select__label">
                    ${row.custom ? t("common.multiSelect.addCustom", { value: row.value }) : row.label}
                  </span>
                  ${
                    row.detail
                      ? html`<span class="picker-select__description">${row.detail}</span>`
                      : nothing
                  }
                </span>
              </div>
            `,
          )}
          ${
            rows.length === 0
              ? html`<div class="multi-select__empty">${t("common.multiSelect.noMatches")}</div>`
              : nothing
          }
        </div>
      </wa-popup>
    `;
  }
}
