import { consume } from "@lit/context";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { until } from "lit/directives/until.js";
import type { RouteId } from "../../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { icons } from "../../../components/icons.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { t } from "../../../i18n/index.ts";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";

class OpenClawBrowserTabCard extends OpenClawLitElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext<RouteId>;
  @property({ attribute: false }) preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  @property({ attribute: false }) revision?: string;
  @property({ type: Boolean }) latest = false;

  private readonly subscriptions = new SubscriptionsController(this);

  constructor() {
    super();
    this.subscriptions.watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    );
  }

  static override styles = css`
    :host {
      display: block;
      max-width: 320px;
      margin-block: 8px;
    }
    button {
      display: grid;
      width: 100%;
      min-width: 0;
      padding: 0;
      overflow: hidden;
      color: var(--text);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font: inherit;
      text-align: start;
      cursor: default;
    }
    button:hover {
      background: var(--panel-hover);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 10px;
    }
    .icon {
      display: flex;
      flex: 0 0 16px;
      color: var(--muted);
    }
    .icon svg {
      width: 16px;
      height: 16px;
    }
    .identity {
      display: grid;
      min-width: 0;
      gap: 2px;
    }
    .title,
    .url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title {
      font-size: 0.8rem;
      font-weight: 500;
    }
    .url {
      color: var(--muted);
      font-size: 0.72rem;
    }
    img {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 10;
      max-height: 180px;
      object-fit: cover;
      object-position: top;
      border-top: 1px solid var(--border);
    }
  `;

  override render() {
    const preview = this.preview;
    if (!preview) {
      return nothing;
    }
    let host = preview.url;
    try {
      host = new URL(preview.url ?? "").host || preview.url;
    } catch {
      // Internal page URLs can have no host; keep the supplied label.
    }
    const title = preview.title?.trim() || host || t("browser.title");
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const thumbnail =
      context &&
      snapshot?.client &&
      isBrowserPanelAvailable(snapshot) &&
      this.latest &&
      this.revision
        ? loadBrowserTabThumbnail({
            client: snapshot.client,
            targetId: preview.targetId,
            revision: this.revision,
            resourceBasePath: context.resourceBasePath,
            authToken: resolveControlUiAuthToken({
              hello: snapshot.hello,
              settings: { token: context.gateway.connection.token },
              password: context.gateway.connection.password,
            }),
          }).then((src) => (src ? html`<img src=${src} alt="" />` : nothing))
        : nothing;
    return html`
      <button
        type="button"
        title=${t("browser.openPanel")}
        @click=${() =>
          this.dispatchEvent(
            new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
              detail: { open: true },
              bubbles: true,
              composed: true,
            }),
          )}
      >
        <span class="header">
          <span class="icon" aria-hidden="true">${icons.globe}</span>
          <span class="identity">
            <span class="title">${title}</span>
            ${preview.url ? html`<span class="url">${preview.url}</span>` : nothing}
          </span>
        </span>
        ${until(thumbnail, nothing)}
      </button>
    `;
  }
}

if (!customElements.get("openclaw-browser-tab-card")) {
  customElements.define("openclaw-browser-tab-card", OpenClawBrowserTabCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-tab-card": OpenClawBrowserTabCard;
  }
}
