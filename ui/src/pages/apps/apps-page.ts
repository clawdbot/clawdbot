import { consume } from "@lit/context";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { isNativeWebChromeHost } from "../../app/native-web-chrome.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildMacGatewayLaunchUrl } from "./gateway-launch.ts";
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
      (gatewaySnapshot.phase === "connected") && hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null);
    const body = renderApps({
      onNavigate: (routeId: RouteId) => this.context.navigate(routeId),
      macGatewayLaunchUrl:
        gatewaySnapshot.phase === "connected" && !isNativeWebChromeHost()
          ? buildMacGatewayLaunchUrl(
              this.context.gateway.connection.gatewayUrl,
              asOptionalRecord(gatewaySnapshot.hello?.snapshot)?.controlUiIdentityUrl,
            )
          : null,
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
