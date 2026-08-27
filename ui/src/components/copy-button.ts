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

function setButtonLabel(button: HTMLButtonElement, label: string) {
  button.setAttribute("aria-label", label);
  // Feedback sits beside fixed-size icons; actionable tooltips dismiss on click.
  const feedback = button.parentElement?.querySelector<HTMLElement>("[data-copy-feedback]");
  if (feedback) {
    feedback.hidden = !button.dataset.copied && !button.dataset.error;
    feedback.textContent = feedback.hidden ? "" : label;
  }
  // Preserve Lit's marker nodes so a later locale change can rerender this label.
  const visibleLabel = button.querySelector("[data-copy-label]")?.lastChild;
  if (visibleLabel?.nodeType === Node.TEXT_NODE) {
    visibleLabel.nodeValue = label;
  }
}

export async function handleCopyButton(event: Event, text: string, idleLabel: string) {
  const button = event.currentTarget as HTMLButtonElement | null;
  if (!button || button.dataset.copying === "1") {
    return false;
  }

  // Older reset timers must not replace feedback from a newer copy attempt.
  const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
  button.dataset.copyAttempt = attempt;
  button.dataset.copying = "1";
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  delete button.dataset.copied;
  delete button.dataset.error;
  setButtonLabel(button, idleLabel);

  // Retired buttons must not overwrite a newer copy through the legacy fallback.
  const isCurrent = () => button.isConnected && button.dataset.copyAttempt === attempt;
  const copied = await copyToClipboard(text, isCurrent);
  delete button.dataset.copying;
  button.removeAttribute("aria-busy");
  button.disabled = false;
  if (!isCurrent()) {
    return false;
  }

  const feedback = copied ? "copied" : "error";
  button.dataset[feedback] = "1";
  const feedbackLabel = t(copied ? "common.copied" : "common.copyFailed");
  setButtonLabel(button, feedbackLabel);

  const duration = copied ? COPIED_FOR_MS : ERROR_FOR_MS;
  window.setTimeout(() => {
    if (!isCurrent()) {
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
  return copied;
}

function createCopyButton(text: string, idleLabel: string, bare = false): TemplateResult {
  // Chat footers own their ghost chrome; .btn backgrounds would box the icon.
  return html`
    <openclaw-tooltip .content=${idleLabel}>
      <button
        class=${bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
        type="button"
        aria-label=${idleLabel}
        @click=${(event: Event) => void handleCopyButton(event, text, idleLabel)}
      >
        <span class="chat-copy-btn__icon" aria-hidden="true">
          <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
          <span class="chat-copy-btn__icon-check">${icons.check}</span>
        </span>
      </button>
      <span data-copy-feedback role="status" hidden></span>
    </openclaw-tooltip>
  `;
}

export function renderCopyButton(text: string, label?: string): TemplateResult {
  return createCopyButton(text, label ?? copyMarkdownLabel());
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton(markdown, copyMarkdownLabel(), true);
}
