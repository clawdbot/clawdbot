/** Shared mocked ACP connection and Gateway client helpers for translator tests. */
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import { AcpGatewayAgent } from "./translator.js";

type TestAcpConnection = AgentSideConnection & {
  __requestPermissionMock: ReturnType<typeof vi.fn>;
  __sessionUpdateMock: ReturnType<typeof vi.fn>;
};

type TestAcpGatewayAgentOptions = AcpServerOptions & {
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
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

/** Creates a mocked Gateway client for translator tests. */
export function createAcpGateway(
  request: GatewayClient["request"] = vi.fn(async () => ({ ok: true })) as GatewayClient["request"],
): GatewayClient {
  return {
    request,
  } as unknown as GatewayClient;
}

/** Creates an ACP translator with an explicit test-owned SQLite event ledger. */
export function createAcpGatewayAgent(
  connection: AgentSideConnection,
  gateway: GatewayClient,
  options: TestAcpGatewayAgentOptions = {},
): AcpGatewayAgent {
  return new AcpGatewayAgent(connection, gateway, {
    ...options,
    eventLedger: options.eventLedger ?? createTestAcpEventLedger(),
  });
}
