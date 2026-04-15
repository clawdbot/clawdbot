export function formatDiscordStartupStatusMessage(params: {
  gatewayReady: boolean;
  botIdentity?: string;
}): string {
  const identitySuffix = params.botIdentity ? ` as ${params.botIdentity}` : "";
  if (params.gatewayReady) {
    return `logged in to discord${identitySuffix}`;
  }
  return `discord client initialized${identitySuffix}; awaiting gateway readiness`;
}
