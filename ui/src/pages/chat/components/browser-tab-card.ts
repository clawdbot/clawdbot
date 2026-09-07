import { consume } from "@lit/context";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { RouteId } from "../../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { browserTabKey, readBrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { t } from "../../../i18n/index.ts";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { openExternalUrlSafe } from "../../../lib/open-external-url.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";

class OpenClawBrowserTabCard extends OpenClawLitElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext<RouteId>;
  @property({ attribute: false }) preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  @property({ attribute: false }) revision?: string;
  @property({ type: Boolean }) latest = false;

  @state() private thumbnailSrc?: string;
  private requestIdentity?: { client: unknown; key: string };

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
      margin-block: 6px;
    }
    .card {
      overflow: hidden;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .shot {
      display: block;
      width: 100%;
      padding: 0;
      background: none;
      border: 0;
      cursor: default;
    }
    .shot img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 240px;
      object-fit: cover;
      object-position: top;
    }
    .bar {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 7px 8px 7px 10px;
    }
    .shot + .bar {
      border-top: 1px solid var(--border);
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
      flex: 1;
      min-width: 0;
      gap: 1px;
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
    .actions {
      display: flex;
      flex: none;
      gap: 2px;
      align-items: center;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .card:hover .actions,
    .card:focus-within .actions,
    .actions:has(wa-dropdown[open]) {
      opacity: 1;
    }
    .actions button {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      color: var(--text);
      font: inherit;
      font-size: 0.75rem;
      background: none;
      border: 0;
      border-radius: var(--radius-sm);
      cursor: default;
    }
    .actions button:hover {
      background: var(--panel-hover);
    }
    .actions button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .actions .more svg {
      width: 16px;
      height: 16px;
    }
  `;

  override updated() {
    const preview = this.preview;
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const revision = this.revision;
    if (
      !preview ||
      !context ||
      !snapshot ||
      !client ||
      !isBrowserPanelAvailable(snapshot) ||
      !this.latest ||
      !revision
    ) {
      if (!this.latest || !snapshot || !isBrowserPanelAvailable(snapshot)) {
        // Dropping the request marker keeps a pending capture from landing and
        // lets a later availability recovery re-request the thumbnail.
        this.requestIdentity = undefined;
        this.thumbnailSrc = undefined;
      }
      return;
    }
    const key = JSON.stringify([browserTabKey(preview), revision]);
    if (this.requestIdentity?.key === key && this.requestIdentity.client === client) {
      return;
    }
    const identity = { client, key };
    this.requestIdentity = identity;
    this.thumbnailSrc = undefined;
    void loadBrowserTabThumbnail({
      client,
      tab: preview,
      revision,
      resourceBasePath: context.resourceBasePath,
      authToken: resolveControlUiAuthToken({
        hello: snapshot.hello,
        settings: { token: context.gateway.connection.token },
        password: context.gateway.connection.password,
      }),
    }).then((src) => {
      if (this.requestIdentity === identity) {
        this.thumbnailSrc = src;
      }
    });
  }

  private readonly openPanel = () => {
    const browserTab = readBrowserTabTarget(this.preview);
    if (!browserTab) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
        detail: { open: true, browserTab },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private readonly onMenuSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    const url = this.preview?.url;
    if (!url) {
      return;
    }
    if (event.detail.item.value === "copy-url") {
      navigator.clipboard.writeText(url).catch(() => {
        // Clipboard access can be denied; the URL stays visible on the card.
      });
    } else if (event.detail.item.value === "open-new-tab") {
      openExternalUrlSafe(url);
    }
  };

  override render() {
    const preview = this.preview;
    if (!preview) {
      return nothing;
    }
    const currentImage =
      this.requestIdentity?.client === this.context?.gateway.snapshot.client &&
      this.requestIdentity?.key === JSON.stringify([browserTabKey(preview), this.revision])
        ? this.thumbnailSrc
        : undefined;
    let host = preview.url;
    try {
      host = new URL(preview.url ?? "").host || preview.url;
    } catch {
      // Internal page URLs can have no host; keep the supplied label.
    }
    const title = preview.title?.trim() || host || t("browser.title");
    const label = preview.url ? `${title} — ${preview.url}` : title;
    return html`
      <div class="card">
        ${
          currentImage
            ? html`
                <button
                  type="button"
                  class="shot"
                  aria-label=${label}
                  title=${t("browser.openPanel")}
                  @click=${this.openPanel}
                >
                  <img src=${currentImage} alt="" />
                </button>
              `
            : nothing
        }
        <div class="bar">
          <span class="icon" aria-hidden="true">${icons.globe}</span>
          <span class="identity">
            <span class="title">${title}</span>
            ${preview.url ? html`<span class="url">${preview.url}</span>` : nothing}
          </span>
          <span class="actions">
            <button type="button" title=${t("browser.openPanel")} @click=${this.openPanel}>
              ${t("browser.open")}
            </button>
            <wa-dropdown placement="bottom-end" @wa-select=${this.onMenuSelect}>
              <button
                slot="trigger"
                type="button"
                class="more"
                aria-haspopup="menu"
                title=${t("browser.moreActions")}
              >
                ${icons.moreHorizontal}
              </button>
              <wa-dropdown-item value="copy-url">${t("browser.copyUrl")}</wa-dropdown-item>
              <wa-dropdown-item value="open-new-tab" data-new-tab-action>
                ${t("browser.openNewTab")}
              </wa-dropdown-item>
            </wa-dropdown>
          </span>
        </div>
      </div>
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
