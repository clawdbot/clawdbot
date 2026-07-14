// Control UI chat module implements copy as markdown behavior.
import { html, type TemplateResult } from "lit";
import { copyToClipboard } from "../lib/clipboard.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_LABEL = "Copy as markdown";
const COPIED_LABEL = "Copied";
const ERROR_LABEL = "Copy failed";

type CopyButtonOptions = {
  text: () => string;
  label?: string;
};

type CopyButtonState = "idle" | "copying" | "copied" | "error";

interface CopyButtonElement extends HTMLButtonElement {
  __copyState?: CopyButtonState;
  __copyTimeout?: number;
}

function setButtonState(button: CopyButtonElement, state: CopyButtonState, idleLabel: string) {
  button.__copyState = state;

  switch (state) {
    case "copying":
      button.dataset.copying = "1";
      button.setAttribute("aria-busy", "true");
      button.disabled = true;
      button.setAttribute("aria-label", idleLabel);
      break;
    case "copied":
      delete button.dataset.copying;
      button.removeAttribute("aria-busy");
      button.disabled = false;
      button.dataset.copied = "1";
      button.setAttribute("aria-label", COPIED_LABEL);
      break;
    case "error":
      delete button.dataset.copying;
      button.removeAttribute("aria-busy");
      button.disabled = false;
      button.dataset.error = "1";
      button.setAttribute("aria-label", ERROR_LABEL);
      break;
    default:
      delete button.dataset.copying;
      delete button.dataset.copied;
      delete button.dataset.error;
      button.removeAttribute("aria-busy");
      button.disabled = false;
      button.setAttribute("aria-label", idleLabel);
  }
}

function cleanupButtonState(button: CopyButtonElement) {
  if (button.__copyTimeout !== undefined) {
    window.clearTimeout(button.__copyTimeout);
    button.__copyTimeout = undefined;
  }
  delete button.__copyState;
}

function resetButtonToIdle(button: CopyButtonElement, idleLabel: string) {
  cleanupButtonState(button);
  setButtonState(button, "idle", idleLabel);
}

function scheduleStateReset(button: CopyButtonElement, state: CopyButtonState, idleLabel: string, delay: number) {
  cleanupButtonState(button);
  button.__copyTimeout = window.setTimeout(() => {
    button.__copyTimeout = undefined;
    if (button.isConnected && button.__copyState === state) {
      resetButtonToIdle(button, idleLabel);
    }
  }, delay);
}

function createCopyButton(options: CopyButtonOptions): TemplateResult {
  const idleLabel = options.label ?? COPY_LABEL;
  return html`
    <openclaw-tooltip .content=${idleLabel}>
      <button
        class="btn btn--xs chat-copy-btn"
        type="button"
        aria-label=${idleLabel}
        @click=${async (e: Event) => {
          const btn = e.currentTarget as CopyButtonElement | null;

          if (!btn || btn.__copyState === "copying") {
            return;
          }

          setButtonState(btn, "copying", idleLabel);

          try {
            const copied = await copyToClipboard(options.text());

            if (!btn.isConnected) {
              return;
            }

            if (!copied) {
              setButtonState(btn, "error", idleLabel);
              scheduleStateReset(btn, "error", idleLabel, ERROR_FOR_MS);
              return;
            }

            setButtonState(btn, "copied", idleLabel);
            scheduleStateReset(btn, "copied", idleLabel, COPIED_FOR_MS);
          } catch {
            if (!btn.isConnected) {
              return;
            }

            setButtonState(btn, "error", idleLabel);
            scheduleStateReset(btn, "error", idleLabel, ERROR_FOR_MS);
          }
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            (e.currentTarget as HTMLButtonElement).click();
          }
        }}
        @mouseleave=${(e: Event) => {
          const btn = e.currentTarget as CopyButtonElement;
          if (btn.__copyState === "copied" || btn.__copyState === "error") {
            resetButtonToIdle(btn, idleLabel);
          }
        }}
      >
        <span class="chat-copy-btn__icon" aria-hidden="true">
          <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
          <span class="chat-copy-btn__icon-check">${icons.check}</span>
        </span>
      </button>
    </openclaw-tooltip>
  `;
}

export function renderCopyButton(text: string, label = COPY_LABEL): TemplateResult {
  return createCopyButton({ text: () => text, label });
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return renderCopyButton(markdown, COPY_LABEL);
}
