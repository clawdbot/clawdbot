import { consume } from "@lit/context";
import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderApps } from "./view.ts";

class AppsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  // Re-render on gateway snapshots so the pairing affordance follows the
  // connection/admin state, mirroring the agent-menu canPairDevice gate.
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const canPairDevice =
      gatewaySnapshot.connected && hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null);
    const body = renderApps({
      onNavigate: (routeId: RouteId) => this.context.navigate(routeId),
      onPairDevice: canPairDevice
        ? () => void this.context.overlays.openDevicePairSetup()
        : undefined,
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("apps")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-apps-page")) {
  customElements.define("openclaw-apps-page", AppsPage);
}
