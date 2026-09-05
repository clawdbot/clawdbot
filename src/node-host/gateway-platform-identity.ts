import { resolveMachineModelIdentifier } from "../infra/machine-model.js";
import { resolveGatewayClientPlatformIdentity } from "../shared/gateway-client-platform.js";

export function resolveNodeHostGatewayPlatformIdentity(
  platform: NodeJS.Platform,
  resolveModel = resolveMachineModelIdentifier,
): {
  platform: string;
  deviceFamily?: string;
  modelIdentifier?: string;
} {
  const modelIdentifier = resolveModel(platform);
  const identity = resolveGatewayClientPlatformIdentity(platform);
  return identity.deviceFamily ? { ...identity, modelIdentifier } : identity;
}
