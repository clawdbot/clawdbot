// Control UI chat module implements copy as markdown behavior.
import { html, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
export function copyMarkdownLabel(): string {
  return t("chat.actions.copyAsMarkdown");
}

type CopyButtonOptions = {
  text: () => string;
  label?: string;
  // Chat message footers style their buttons as ghost icons; the .btn chrome
  // (light-mode background overrides) would outrank those rules and box them.
  bare?: boolean;
};

function setButtonLabel(button: HTMLButtonElement, label: string) {
  button.setAttribute("aria-label", label);
  // Preserve Lit's marker nodes so a later locale change can rerender this label.
  const visibleLabel = button.querySelector("[data-copy-label]")?.lastChild;
  if (visibleLabel?.nodeType === Node.TEXT_NODE) {
    visibleLabel.nodeValue = label;
  }
}

export async function handleCopyButton(event: Event, text: string, idleLabel: string) {
  const button = event.currentTarget as HTMLButtonElement | null;
  if (!button || button.dataset.copying === "1") {
    return;
  }

  // Older reset timers must not replace feedback from a newer copy attempt.
  const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
  button.dataset.copyAttempt = attempt;
  button.dataset.copying = "1";
  button.setAttribute("aria-busy", "true");
  button.disabled = true;

  const copied = await copyToClipboard(text);
  delete button.dataset.copying;
  button.removeAttribute("aria-busy");
  button.disabled = false;
  if (!button.isConnected || button.dataset.copyAttempt !== attempt) {
    return;
  }

  const feedback = copied ? "copied" : "error";
  delete button.dataset[copied ? "error" : "copied"];
  button.dataset[feedback] = "1";
  const feedbackLabel = t(copied ? "common.copied" : "common.copyFailed");
  setButtonLabel(button, feedbackLabel);

  const duration = copied ? COPIED_FOR_MS : ERROR_FOR_MS;
  window.setTimeout(() => {
    if (!button.isConnected || button.dataset.copyAttempt !== attempt) {
      return;
    }
    delete button.dataset[feedback];
    // A locale rerender can replace the idle label while feedback is still active.
    const renderedLabel =
      button.querySelector("[data-copy-label]")?.textContent ?? button.getAttribute("aria-label");
    setButtonLabel(
      button,
      renderedLabel && renderedLabel !== feedbackLabel ? renderedLabel : idleLabel,
    );
  }, duration);
}

function createCopyButton(options: CopyButtonOptions): TemplateResult {
  const idleLabel = options.label ?? copyMarkdownLabel();
  return html`
    <openclaw-tooltip .content=${idleLabel}>
      <button
        class=${options.bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
        type="button"
        aria-label=${idleLabel}
        @click=${(event: Event) => void handleCopyButton(event, options.text(), idleLabel)}
      >
        <span class="chat-copy-btn__icon" aria-hidden="true">
          <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
          <span class="chat-copy-btn__icon-check">${icons.check}</span>
        </span>
      </button>
    </openclaw-tooltip>
  `;
}

export function renderCopyButton(text: string, label?: string): TemplateResult {
  return createCopyButton({ text: () => text, label });
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton({ text: () => markdown, bare: true });
}
