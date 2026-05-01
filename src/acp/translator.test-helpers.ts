import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";

type TestAcpConnection = AgentSideConnection & {
  __sessionUpdateMock: ReturnType<typeof vi.fn>;
};

export function createAcpConnection(): TestAcpConnection {
  const sessionUpdate = vi.fn(async () => {});
  return {
    sessionUpdate,
    __sessionUpdateMock: sessionUpdate,
  } as unknown as TestAcpConnection;
}

export function createAcpGateway(
  request: GatewayClient["request"] = vi.fn(async () => ({ ok: true })) as GatewayClient["request"],
): GatewayClient {
  return {
    request,
  } as unknown as GatewayClient;
}
