import { vi, type Mock } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";

export type GatewayRequestHandler = (
  ...args: Parameters<GatewayBrowserClient["request"]>
) => unknown;

export type GatewayRequestMock = Mock<GatewayRequestHandler>;

export function createGatewayRequestMock(
  implementation: GatewayRequestHandler = async () => ({}),
): GatewayRequestMock {
  return vi.fn(implementation);
}

export function createTestGatewayClient(request: GatewayRequestHandler): GatewayBrowserClient {
  const client = new GatewayBrowserClient({ url: "ws://test.invalid" });
  // Request stubs represent an authenticated client whose recovery scope has settled.
  Object.defineProperty(client, "recoveryScope", {
    configurable: true,
    get: () => "test-recovery-scope",
  });
  Object.defineProperty(client, "recoveryScopeReady", { configurable: true, get: () => true });
  client.request = async <T = unknown>(
    ...args: Parameters<GatewayBrowserClient["request"]>
  ): Promise<T> => (await request(...args)) as T;
  return client;
}
