/** Shared mocked ACP connection and Gateway client helpers for translator tests. */
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";

type TestAcpConnection = AgentSideConnection & {
  __requestPermissionMock: ReturnType<typeof vi.fn>;
  __sessionUpdateMock: ReturnType<typeof vi.fn>;
};

/** Creates a mocked ACP connection with exposed permission and update spies. */
export function createAcpConnection(
  params: {
    requestPermission?: ReturnType<typeof vi.fn>;
  } = {},
): TestAcpConnection {
  const requestPermission =
    params.requestPermission ?? vi.fn(async () => ({ outcome: { outcome: "cancelled" } }));
  const sessionUpdate = vi.fn(async () => {});
  return {
    requestPermission,
    sessionUpdate,
    __requestPermissionMock: requestPermission,
    __sessionUpdateMock: sessionUpdate,
  } as unknown as TestAcpConnection;
}

/**
 * Creates a mocked Gateway client for translator tests. It advertises the current server
 * capabilities by default; pass an explicit list (or `[]`) to model an older Gateway.
 */
export function createAcpGateway(
  request: GatewayClient["request"] = vi.fn(async (method: string, params?: unknown) =>
    acpGatewayDefaultResponse(method, params),
  ) as GatewayClient["request"],
  options: { serverCapabilities?: readonly string[] } = {},
): GatewayClient {
  const capabilities = new Set<string>(
    options.serverCapabilities ?? Object.values(GATEWAY_SERVER_CAPS),
  );
  return {
    request,
    hasServerCapability: (capability: string) => capabilities.has(capability),
  } as unknown as GatewayClient;
}

/**
 * Mirrors the Gateway shapes the ACP bridge actually reads: sessions.create echoes the requested
 * cwd back as the new row's spawnedCwd, which the bridge treats as the session's real directory.
 * Partial mocks should fall through to this so they keep modelling the responses they don't stub.
 */
export function acpGatewayDefaultResponse(method: string, params?: unknown): unknown {
  if (method === "sessions.create") {
    const cwd = (params as { cwd?: string } | undefined)?.cwd;
    return { ok: true, entry: cwd ? { spawnedCwd: cwd } : {} };
  }
  return { ok: true };
}
