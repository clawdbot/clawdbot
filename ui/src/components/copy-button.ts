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
}

function createCopyButton(options: CopyButtonOptions): TemplateResult {
  const idleLabel = options.label ?? copyMarkdownLabel();
  return html`
    <openclaw-tooltip .content=${idleLabel}>
      <button
        class=${options.bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
        type="button"
        aria-label=${idleLabel}
        @click=${async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement | null;

          if (!btn || btn.dataset.copying === "1") {
            return;
          }

          btn.dataset.copying = "1";
          btn.setAttribute("aria-busy", "true");
          btn.disabled = true;

          const copied = await copyToClipboard(options.text());
          if (!btn.isConnected) {
            return;
          }

          delete btn.dataset.copying;
          btn.removeAttribute("aria-busy");
          btn.disabled = false;

          if (!copied) {
            btn.dataset.error = "1";
            setButtonLabel(btn, t("common.copyFailed"));

            window.setTimeout(() => {
              if (!btn.isConnected) {
                return;
              }
              delete btn.dataset.error;
              setButtonLabel(btn, idleLabel);
            }, ERROR_FOR_MS);
            return;
          }

          btn.dataset.copied = "1";
          setButtonLabel(btn, t("common.copied"));

          window.setTimeout(() => {
            if (!btn.isConnected) {
              return;
            }
            delete btn.dataset.copied;
            setButtonLabel(btn, idleLabel);
          }, COPIED_FOR_MS);
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

export function renderCopyButton(text: string, label?: string): TemplateResult {
  return createCopyButton({ text: () => text, label });
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton({ text: () => markdown, bare: true });
}
