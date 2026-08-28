import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { ChatSendShortcut } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutParts,
  resolveKeyboardShortcutSections,
} from "../lib/keyboard-shortcut-catalog.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import "./modal-dialog.ts";

class KeyboardShortcutsDialog extends OpenClawLitElement {
  @property({ attribute: false }) sendShortcut: ChatSendShortcut = "enter";
  @state() private open = false;

  static override styles = css`
    :host {
      display: contents;
      --openclaw-modal-width: 560px;
    }

    .dialog {
      display: flex;
      max-height: min(720px, calc(100dvh - 64px));
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--card);
      color: var(--text);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 22px 16px;
      border-bottom: 1px solid var(--border);
    }

    h2 {
      margin: 0;
      color: var(--text-strong);
      font-size: 16px;
      font-weight: 600;
    }

    .close {
      display: grid;
      width: 28px;
      height: 28px;
      place-items: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 20px;
    }

    .close:hover {
      background: var(--bg-hover);
      color: var(--text);
    }

    .body {
      overflow: auto;
      padding: 8px 22px 18px;
    }

    section + section {
      margin-top: 12px;
      border-top: 1px solid var(--border);
    }

    h3 {
      margin: 18px 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .shortcut-row {
      display: flex;
      min-height: 34px;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-size: 13px;
    }

    .combos {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .combo {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    kbd {
      min-width: 22px;
      padding: 3px 6px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      background: var(--bg-muted);
      color: var(--text);
      font: inherit;
      font-size: 12px;
      text-align: center;
    }
  `;

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
  }

  override render() {
    if (!this.open) {
      return nothing;
    }
    const close = () => {
      this.open = false;
    };
    return html`
      <openclaw-modal-dialog label=${t("shortcutsOverlay.title")} @modal-cancel=${close}>
        <div class="dialog">
          <header class="header">
            <h2>${t("shortcutsOverlay.title")}</h2>
            <button class="close" type="button" aria-label=${t("common.close")} @click=${close}>
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div class="body">
            ${resolveKeyboardShortcutSections(this.sendShortcut).map(
              (section) => html`
                <section>
                  <h3>${t(section.label)}</h3>
                  ${section.entries.map(
                    (entry) => html`
                      <div class="shortcut-row">
                        <span>${t(entry.label)}</span>
                        <span class="combos">
                          ${entry.combos.map(
                            (combo) => html`
                              <span class="combo">
                                ${formatKeyboardShortcutParts(combo).map(
                                  (part) => html`<kbd>${part}</kbd>`,
                                )}
                              </span>
                            `,
                          )}
                        </span>
                      </div>
                    `,
                  )}
                </section>
              `,
            )}
          </div>
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-keyboard-shortcuts-dialog")) {
  customElements.define("openclaw-keyboard-shortcuts-dialog", KeyboardShortcutsDialog);
}
