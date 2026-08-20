import { vi, type Mock } from "vitest";
import { GatewayBrowserClient } from "../api/gateway.ts";

export type GatewayRequestHandler = (method: string, params?: unknown) => unknown;

export type GatewayRequestMock = Mock<GatewayRequestHandler>;

export function createGatewayRequestMock(
  implementation: GatewayRequestHandler = async () => ({}),
): GatewayRequestMock {
  return vi.fn(implementation);
}

export function createTestGatewayClient(request: GatewayRequestHandler): GatewayBrowserClient {
  const client = new GatewayBrowserClient({ url: "ws://test.invalid" });
  client.request = async <T = unknown>(method: string, params?: unknown): Promise<T> =>
    (await request(method, params)) as T;
  return client;
}
