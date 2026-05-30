import { describe, expect, it } from "vitest";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mjs";

describe("gateway network WebSocket open guard", () => {
  it("rejects loose client timeout env values instead of parsing prefixes", () => {
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "100ms",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 100ms");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: 1e3");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "0",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 0");
  });

  it("prefers the explicit client timeout over the connect-ready fallback", () => {
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "5000",
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1000",
      }),
    ).toBe(5000);
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "3000",
      }),
    ).toBe(3000);
  });
});
