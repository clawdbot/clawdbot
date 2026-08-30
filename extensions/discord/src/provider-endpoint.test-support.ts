import {
  DISCORD_PROVIDER_ENDPOINT_ENV_KEYS,
  type DiscordProviderEndpointDescriptor,
} from "./provider-endpoint.constants.js";

export function createDiscordProviderEndpointEnvForTest(
  descriptor: DiscordProviderEndpointDescriptor,
): NodeJS.ProcessEnv {
  return {
    [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: descriptor.restApiBaseUrl,
    [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl]: descriptor.gatewayBotUrl,
    [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayOrigin]: descriptor.gatewayOrigin,
  };
}

export async function initializeDiscordProviderEndpointForTest(
  descriptor: DiscordProviderEndpointDescriptor,
): Promise<void> {
  const { initializeDiscordProviderEndpointFromEnv } = await import("./provider-endpoint.js");
  initializeDiscordProviderEndpointFromEnv(createDiscordProviderEndpointEnvForTest(descriptor));
}
