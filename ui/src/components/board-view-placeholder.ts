import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import type { BoardViewCallbacks } from "../lib/board/provider.ts";
import type { BoardSnapshot, BoardWidget } from "../lib/board/types.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

class OpenClawBoardViewPlaceholder extends OpenClawLitElement {
  @property({ attribute: false }) snapshot!: BoardSnapshot;
  @property({ attribute: false }) activeTabId = "";
  @property({ attribute: false }) widgetFrameUrl!: (name: string, revision: number) => string;
  @property({ attribute: false }) callbacks!: BoardViewCallbacks;

  static override styles = css`
    :host {
      display: grid;
      min-width: 0;
      min-height: 0;
      height: 100%;
      place-items: center;
      color: var(--muted);
      background:
        linear-gradient(color-mix(in srgb, var(--border) 22%, transparent) 1px, transparent 1px),
        linear-gradient(
          90deg,
          color-mix(in srgb, var(--border) 22%, transparent) 1px,
          transparent 1px
        );
      background-size: 24px 24px;
    }

    div {
      padding: 12px 16px;
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      font-size: 12px;
      letter-spacing: 0.01em;
    }
  `;

  override render() {
    const widgets: readonly BoardWidget[] = this.snapshot?.widgets ?? [];
    return html`<div data-board-view-placeholder>
      ${t("chat.board.mockPlaceholder", {
        tabs: String(this.snapshot?.tabs.length ?? 0),
        widgets: String(widgets.length),
      })}
    </div>`;
  }
}

if (!customElements.get("openclaw-board-view")) {
  customElements.define("openclaw-board-view", OpenClawBoardViewPlaceholder);
}
