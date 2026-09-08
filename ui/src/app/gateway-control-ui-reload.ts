import { CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { ApplicationGateway } from "./gateway.ts";
import { reloadControlUiDocument } from "./stale-chunk-reload.ts";

export function createGatewayControlUiReloadOptions(
  gateway: ApplicationGateway,
  canReload?: () => boolean,
) {
  const {
    connection,
    snapshot: { client },
  } = gateway;
  return {
    // Snapshot observers can replace the original callback's client before scheduling;
    // document probes can then outlive the connection captured here as well.
    canReload: () =>
      canReload?.() !== false &&
      client !== null &&
      gateway.snapshot.client === client &&
      gateway.connection === connection &&
      // Ordinary refreshes carry no credential into the serving document.
      (!connection.bootstrapToken || isSameOriginGateway(connection.gatewayUrl)),
    reload: () => {
      const url = new URL(window.location.href);
      if (connection.bootstrapToken) {
        // Another tab can change the saved Gateway during the probe. Keep this
        // pending handoff bound to its destination through startup confirmation.
        url.searchParams.delete("gatewayUrl");
        const fragment = new URLSearchParams(url.hash.slice(1));
        fragment.set("gatewayUrl", connection.gatewayUrl);
        fragment.set("bootstrapToken", connection.bootstrapToken);
        if (connection.bootstrapProfile) {
          fragment.set(CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM, connection.bootstrapProfile);
        }
        url.hash = fragment.toString();
      }
      reloadControlUiDocument(url);
    },
  };
}

export function isSameOriginGateway(gatewayUrl: string): boolean {
  try {
    return new URL(gatewayUrl.replace(/^ws/u, "http")).origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}
