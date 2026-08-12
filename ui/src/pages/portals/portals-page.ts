import { consume } from "@lit/context";
import type {
  PortalChangedEvent,
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolvePortalUrl } from "./portal-url.ts";
import "./portals.css";

const PORTAL_FRAME_SANDBOX =
  "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts";

class PortalsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private portals: PortalSummary[] = [];
  @state() private selectedPortalId: string | null = null;
  @state() private loading = false;
  @state() private loaded = false;
  @state() private error: string | null = null;
  @state() private closingPortalId: string | null = null;

  private requestGeneration = 0;
  private portalSetRevision = 0;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => void this.loadPortals(),
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (
          this.gateway.gateway !== gateway ||
          this.context.gateway !== gateway ||
          !this.gateway.connected ||
          event.event !== "portal.changed"
        ) {
          return;
        }
        const portals = (event.payload as Partial<PortalChangedEvent> | null)?.portals;
        if (Array.isArray(portals)) {
          this.applyPortalSet(portals);
        }
      }),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private get portalListSupported(): boolean {
    return isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, "portal.list") !== false;
  }

  private get canClosePortal(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "portal.close", "operator.write");
  }

  private resetGatewayState() {
    this.requestGeneration += 1;
    this.portalSetRevision += 1;
    this.portals = [];
    this.selectedPortalId = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.closingPortalId = null;
  }

  private applyPortalSet(portals: readonly PortalSummary[]) {
    this.portalSetRevision += 1;
    this.portals = [...portals];
    this.selectedPortalId = portals.some((portal) => portal.id === this.selectedPortalId)
      ? this.selectedPortalId
      : (portals[0]?.id ?? null);
    this.loaded = true;
    this.error = null;
  }

  private async loadPortals() {
    if (!this.gateway.connected || !this.portalListSupported || this.loading) {
      return;
    }
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!client || !scope) {
      return;
    }
    const generation = ++this.requestGeneration;
    const portalSetRevision = this.portalSetRevision;
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<PortalListResult>("portal.list", {});
      if (
        generation === this.requestGeneration &&
        portalSetRevision === this.portalSetRevision &&
        this.gateway.isCurrent(scope)
      ) {
        this.applyPortalSet(result.portals);
      }
    } catch (error) {
      if (
        generation === this.requestGeneration &&
        this.gateway.isCurrent(scope) &&
        this.portalListSupported
      ) {
        this.error = t("portalsPage.loadFailed", { error: formatUiError(error) });
        this.loaded = true;
      }
    } finally {
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.loading = false;
      }
    }
  }

  private async closePortal(portal: PortalSummary) {
    if (!this.canClosePortal || this.closingPortalId) {
      return;
    }
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!client || !scope) {
      return;
    }
    this.closingPortalId = portal.id;
    this.error = null;
    try {
      await client.request<PortalCloseResult>("portal.close", { id: portal.id });
      if (this.gateway.isCurrent(scope)) {
        void this.loadPortals();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = t("portalsPage.closeFailed", { error: formatUiError(error) });
      }
    } finally {
      if (this.gateway.isCurrent(scope) && this.closingPortalId === portal.id) {
        this.closingPortalId = null;
      }
    }
  }

  private renderEmptyState() {
    const unsupported = !this.portalListSupported;
    return html`
      <section class="portals-empty" role="status" aria-live="polite">
        ${this.loading && !this.loaded
          ? html`<div class="portals-empty__title">${t("portalsPage.loading")}</div>`
          : html`
              <div class="portals-empty__title">${t("portalsPage.emptyHint")}</div>
              <div class="portals-empty__prompts">
                <span>${t("portalsPage.promptShow")}</span>
                <span>${t("portalsPage.promptStart")}</span>
                <span>${t("portalsPage.promptMakeAvailable")}</span>
              </div>
            `}
        ${unsupported
          ? html`<div class="portals-empty__note">${t("portalsPage.unsupported")}</div>`
          : nothing}
        ${this.error ? html`<div class="callout danger">${this.error}</div>` : nothing}
      </section>
    `;
  }

  private renderPortal(portal: PortalSummary) {
    const portalUrl = resolvePortalUrl(
      portal,
      this.context.gateway.connection.gatewayUrl,
      window.location.origin,
    );
    const frameKey = `${portal.id}\u0000${portalUrl}`;
    return html`
      <section class="portals-preview">
        <header class="portals-preview__header">
          <a
            class="portals-preview__url"
            href=${portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title=${portalUrl}
          >
            <span>${portalUrl}</span>
            ${icon("externalLink")}
            <span class="sr-only">${t("portalsPage.openNewTab")}</span>
          </a>
          <button
            class="btn btn--icon btn--ghost portals-preview__close"
            type="button"
            title=${t("portalsPage.closePortal", { title: portal.title })}
            aria-label=${t("portalsPage.closePortal", { title: portal.title })}
            ?disabled=${!this.canClosePortal || this.closingPortalId === portal.id}
            @click=${() => void this.closePortal(portal)}
          >
            ${icon("x")}
          </button>
        </header>
        ${this.error
          ? html`<div class="callout danger portals-preview__error">${this.error}</div>`
          : nothing}
        ${keyed(
          frameKey,
          html`<iframe
            ${ref((element) => {
              if (element instanceof HTMLIFrameElement && !element.hasAttribute("src")) {
                element.setAttribute("src", portalUrl);
              }
            })}
            class="portals-preview__frame"
            title=${t("portalsPage.previewTitle", { title: portal.title })}
            referrerpolicy="no-referrer"
            sandbox=${PORTAL_FRAME_SANDBOX}
          ></iframe>`,
        )}
      </section>
    `;
  }

  override render() {
    const selectedPortal =
      this.portals.find((portal) => portal.id === this.selectedPortalId) ?? this.portals[0];
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("portals")}</div>
        </div>
      </section>
      ${selectedPortal
        ? html`
            <section class="portals-layout">
              <aside class="portals-rail" aria-label=${t("portalsPage.listLabel")}>
                ${this.portals.map(
                  (portal) => html`
                    <button
                      class="portals-rail__item ${portal.id === selectedPortal.id ? "active" : ""}"
                      type="button"
                      aria-current=${portal.id === selectedPortal.id ? "true" : nothing}
                      @click=${() => (this.selectedPortalId = portal.id)}
                    >
                      <span class="portals-rail__title">${portal.title}</span>
                      <span class="portals-rail__port"
                        >${t("portalsPage.portLabel", { port: String(portal.port) })}</span
                      >
                      ${portal.description
                        ? html`<span class="portals-rail__description">${portal.description}</span>`
                        : nothing}
                    </button>
                  `,
                )}
              </aside>
              ${this.renderPortal(selectedPortal)}
            </section>
          `
        : this.renderEmptyState()}
    `;
  }
}

if (!customElements.get("openclaw-portals-page")) {
  customElements.define("openclaw-portals-page", PortalsPage);
}
