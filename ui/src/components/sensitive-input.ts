// Control UI adapter for Carapace's framework-neutral Sensitive Input pattern.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "./icons.ts";
import "./tooltip.ts";

type SensitiveInputProps = {
  id: string;
  name?: string;
  value: string;
  revealed: boolean;
  revealLabel: string;
  hideLabel: string;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  onInput: (value: string) => void;
  onToggle: () => void;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function maskedValue(value: string): string {
  return "*".repeat(Array.from(graphemeSegmenter.segment(value)).length);
}

function syncMask(input: HTMLInputElement): void {
  const control = input.closest<HTMLElement>("[data-sensitive-input]");
  const maskText = control?.querySelector<HTMLElement>("[data-sensitive-mask-text]");
  if (!maskText) {
    return;
  }
  maskText.textContent = maskedValue(input.value);
  maskText.style.transform = `translateX(${-input.scrollLeft}px)`;
}

export function renderSensitiveInput(props: SensitiveInputProps): TemplateResult {
  const visibilityLabel = props.revealed ? props.hideLabel : props.revealLabel;
  const className = props.className
    ? `oc-sensitive-input ${props.className}`
    : "oc-sensitive-input";
  const handleInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    syncMask(input);
    props.onInput(input.value);
  };
  const handleMaskSync = (event: Event) => {
    syncMask(event.currentTarget as HTMLInputElement);
  };

  return html`
    <span
      class=${className}
      data-sensitive-input
      data-sensitive-mask-ready="true"
      data-revealed=${String(props.revealed)}
    >
      <span
        class="oc-sensitive-mask"
        aria-hidden="true"
        data-sensitive-mask
        ?hidden=${props.revealed}
      >
        <span
          data-sensitive-mask-text
          .textContent=${props.revealed ? "" : maskedValue(props.value)}
        ></span>
      </span>
      <input
        id=${props.id}
        class=${props.inputClassName ?? nothing}
        name=${props.name ?? nothing}
        type=${props.revealed ? "text" : "password"}
        autocomplete="off"
        spellcheck="false"
        placeholder=${props.placeholder ?? ""}
        .value=${props.value}
        ?disabled=${props.disabled}
        data-sensitive-value
        @input=${handleInput}
        @change=${handleMaskSync}
        @focus=${handleMaskSync}
        @scroll=${handleMaskSync}
      />
      <openclaw-tooltip .content=${visibilityLabel}>
        <button
          type="button"
          class="oc-sensitive-toggle"
          aria-label=${visibilityLabel}
          aria-controls=${props.id}
          aria-pressed=${String(props.revealed)}
          data-sensitive-icon=${props.revealed ? "eye-off" : "eye"}
          ?disabled=${props.disabled}
          @click=${props.onToggle}
        >
          ${props.revealed ? icons.eyeOff : icons.eye}
        </button>
      </openclaw-tooltip>
    </span>
  `;
}
