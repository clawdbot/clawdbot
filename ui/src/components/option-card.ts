import { LitElement, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import "../styles/option-card.css";

type OptionCardOption = {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

type OptionCardProps = {
  header?: string;
  question: string;
  options: readonly OptionCardOption[];
  disabled?: boolean;
  onSelect?: (value: string) => void;
  onSkip?: () => void;
};

class OptionCard extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: OptionCardProps;
  @state() private selectedValue = "";
  private requestKey = "";
  private focusPreselection = false;

  override willUpdate(): void {
    const props = this.props;
    const requestKey = props
      ? JSON.stringify([
          props.header ?? "",
          props.question,
          props.options.map((option) => [option.value, option.label, option.recommended === true]),
        ])
      : "";
    if (requestKey === this.requestKey) {
      return;
    }
    this.requestKey = requestKey;
    this.selectedValue =
      props?.options.slice(0, 4).find((option) => option.recommended)?.value ?? "";
    this.focusPreselection = Boolean(this.selectedValue);
  }

  override updated(_changedProperties: PropertyValues): void {
    if (!this.focusPreselection || this.props?.disabled) {
      return;
    }
    this.focusPreselection = false;
    const selected = [...this.querySelectorAll<HTMLButtonElement>(".option-card__choice")].find(
      (button) => button.dataset.optionValue === this.selectedValue,
    );
    selected?.focus({ preventScroll: true });
  }

  private select(value: string): void {
    if (this.props?.disabled) {
      return;
    }
    this.selectedValue = value;
    this.props?.onSelect?.(value);
    this.dispatchEvent(
      new CustomEvent<{ value: string }>("option-select", {
        bubbles: true,
        composed: true,
        detail: { value },
      }),
    );
  }

  private skip(): void {
    if (this.props?.disabled) {
      return;
    }
    this.props?.onSkip?.();
    this.dispatchEvent(new CustomEvent("option-skip", { bubbles: true, composed: true }));
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const options = props.options.slice(0, 4);
    const recommendedIndex = options.findIndex((option) => option.recommended === true);
    return html`
      <section class="option-card" role="group" aria-label=${props.question}>
        ${props.header ? html`<div class="option-card__chip">${props.header}</div>` : nothing}
        <div class="option-card__question">${props.question}</div>
        <div class="option-card__choices" role="radiogroup">
          ${options.map((option, index) => {
            const recommended = index === recommendedIndex;
            const selected = option.value === this.selectedValue;
            return html`
              <button
                class=${`option-card__choice ${
                  recommended ? "option-card__choice--recommended" : ""
                } ${selected ? "option-card__choice--selected" : ""}`}
                type="button"
                role="radio"
                aria-checked=${selected ? "true" : "false"}
                data-option-value=${option.value}
                ?disabled=${props.disabled}
                @click=${() => this.select(option.value)}
              >
                <span class="option-card__choice-copy">
                  <strong>${option.label}</strong>
                  ${option.description
                    ? html`<span class="option-card__description">${option.description}</span>`
                    : nothing}
                </span>
                ${recommended
                  ? html`<span class="option-card__recommended">
                      ${t("optionCard.recommended")}
                    </span>`
                  : nothing}
              </button>
            `;
          })}
        </div>
        <button
          class="option-card__skip"
          type="button"
          ?disabled=${props.disabled}
          @click=${() => this.skip()}
        >
          ${t("optionCard.skip")}
        </button>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-option-card")) {
  customElements.define("openclaw-option-card", OptionCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-option-card": OptionCard;
  }
}
