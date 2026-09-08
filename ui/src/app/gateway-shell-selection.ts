import { GatewayRegistryPersistenceError, selectGatewayProfile } from "./gateway-registry.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { loadGatewaySessionSelection } from "./settings.ts";

export function selectAndConnectGateway(gateway: ApplicationGateway, id: string): void {
  let registry;
  try {
    registry = selectGatewayProfile(id, { url: gateway.connection.gatewayUrl });
  } catch (error) {
    if (error instanceof GatewayRegistryPersistenceError) {
      return;
    }
    throw error;
  }
  const profile = registry.gateways.find((candidate) => candidate.id === id);
  if (!profile || profile.url === gateway.connection.gatewayUrl) {
    return;
  }
  gateway.connect({
    gatewayUrl: profile.url,
    sessionKey: loadGatewaySessionSelection(profile.url).sessionKey,
  });
}
