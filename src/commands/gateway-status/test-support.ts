export function createSecretRefGatewayConfig(params?: { gatewayMode?: "local" | "remote" }) {
  return {
    secrets: {
      defaults: {
        env: "default",
      },
    },
    gateway: {
      ...(params?.gatewayMode ? { mode: params.gatewayMode } : {}),
      auth: {
        mode: "token" as const,
        token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      },
      remote: {
        url: "wss://remote.example:18789",
        token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
        password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
      },
    },
  };
}
