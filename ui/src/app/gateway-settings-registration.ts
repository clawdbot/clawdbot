import {
  createGatewayProfile,
  loadGatewayRegistry,
  upsertGatewayProfile,
} from "./gateway-registry.ts";

export function registerGatewayProfileForSettings(
  url: string,
  options: { select?: boolean } = {},
): void {
  const profile = createGatewayProfile({ url });
  if (!profile) {
    return;
  }
  const existing = loadGatewayRegistry(profile).gateways.find(
    (gateway) => gateway.id === profile.id,
  );
  upsertGatewayProfile(existing ? { ...profile, name: existing.name } : profile, options);
}
