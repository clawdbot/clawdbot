export type DiscordProviderEndpointDescriptor = Readonly<{
  /** Complete versioned base URL for Discord REST routes. */
  restApiBaseUrl: string;
  /** Exact authenticated Gateway metadata URL. */
  gatewayBotUrl: string;
  /** Allowed WebSocket origin for initial and resumed Gateway connections. */
  gatewayOrigin: string;
}>;

// Private trusted-host bootstrap contract: the process supervisor owns all three values before
// Discord startup. Workspace .env is blocked, but inherited/global runtime dotenv is trusted;
// unset all or correct all three and restart; absence preserves live Discord routing.
export const DISCORD_PROVIDER_ENDPOINT_ENV_KEYS = {
  restApiBaseUrl: "DISCORD_REST_API_BASE_URL",
  gatewayBotUrl: "DISCORD_GATEWAY_BOT_URL",
  gatewayOrigin: "DISCORD_GATEWAY_ORIGIN",
} as const satisfies Readonly<Record<keyof DiscordProviderEndpointDescriptor, string>>;

export const DISCORD_DEFAULT_REST_API_BASE_URL = "https://discord.com/api/v10";
