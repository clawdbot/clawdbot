import { consume } from "@lit/context";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { formatChatWorkContext, type ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import "../pages/chat/chat-pane.ts";
import "../styles/chat.ts";
import "../styles/chat/composer.css";
import "../styles/chat/composer-status.css";
import { icons } from "./icons.ts";

/** The real Home conversation; its surrounding dock owns placement and focus. */
export class OpenClawHomeSession extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @property({ attribute: false }) workContext: ChatWorkContext = { page: "chat" };
  @state() private includeContext = true;
  @state() private selection = "";
  @state() private selectionAvailable = false;
  private selectionScope = "";
  private readonly updateSelectionAvailability = () => {
    const selection = window.getSelection();
    this.selectionAvailable = Boolean(
      selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      !this.contains(selection.anchorNode),
    );
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("selectionchange", this.updateSelectionAvailability);
    this.updateSelectionAvailability();
  }

  override disconnectedCallback(): void {
    document.removeEventListener("selectionchange", this.updateSelectionAvailability);
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    const work = this.workContext;
    const scope = JSON.stringify([
      this.context.gateway.connection.gatewayUrl,
      work.page,
      work.sessionKey,
      work.sessionId,
      work.agentId,
      work.file,
    ]);
    if (this.selectionScope && this.selectionScope !== scope) {
      this.selection = "";
    }
    this.selectionScope = scope;
  }

  private readonly attachSelection = (event: MouseEvent): void => {
    // Capture only on the explicit action and before focus clears the selection.
    event.preventDefault();
    const selected = window.getSelection();
    if (
      !selected ||
      selected.isCollapsed ||
      (selected.anchorNode && this.contains(selected.anchorNode))
    ) {
      return;
    }
    this.selection = truncateUtf16Safe(selected.toString(), 640);
    this.includeContext = true;
  };

  override render() {
    const context = { ...this.workContext, selection: this.selection || undefined };
    const text = formatChatWorkContext(context);
    const owner = JSON.stringify([
      this.context.gateway.connection.gatewayUrl,
      this.agentId,
      this.sessionKey,
    ]);
    return html`
      <div class="assistant-panel-context">
        ${
          this.includeContext
            ? html`
                <details>
                  <summary>
                    ${t("assistantPanel.context", { context: context.title || context.page })}
                  </summary>
                  <pre>${text}</pre>
                </details>
                <button
                  type="button"
                  class="rail-header__action"
                  aria-label=${t("assistantPanel.removeContext")}
                  @click=${() => {
                    this.includeContext = false;
                  }}
                >
                  ${icons.x}
                </button>
              `
            : html`<button
                type="button"
                class="btn btn--sm"
                @click=${() => {
                  this.includeContext = true;
                }}
              >
                ${t("assistantPanel.includeContext")}
              </button>`
        }
        <button
          type="button"
          class="rail-header__action"
          aria-label=${t("assistantPanel.attachSelection")}
          ?disabled=${!this.selectionAvailable}
          title=${t("assistantPanel.attachSelection")}
          @mousedown=${this.attachSelection}
          @click=${(event: MouseEvent) => {
            if (event.detail === 0) {
              this.attachSelection(event);
            }
          }}
        >
          ${icons.messageSquare}
        </button>
        ${
          this.selection
            ? html`<button
                type="button"
                class="btn btn--sm"
                aria-label=${t("assistantPanel.removeSelection")}
                @click=${() => {
                  this.selection = "";
                }}
              >
                ${t("assistantPanel.selection")} ${icons.x}
              </button>`
            : nothing
        }
      </div>
      ${keyed(
        owner,
        html`<openclaw-chat-pane
          .paneId=${`home-dock:${owner}`}
          .presentationId=${`home-dock:${owner}`}
          .sessionKey=${this.sessionKey}
          .agentId=${this.agentId}
          .inputRegion=${"dock"}
          .active=${true}
          .compact=${true}
          .narrow=${true}
          .workContext=${this.includeContext ? text : undefined}
        ></openclaw-chat-pane>`,
      )}
    `;
  }
}

customElements.define("openclaw-home-session", OpenClawHomeSession);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-home-session": OpenClawHomeSession;
  }
}
