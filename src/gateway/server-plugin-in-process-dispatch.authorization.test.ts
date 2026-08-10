import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";

const startTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn: vi.fn(),
  }),
}));

function createContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function createOperatorClient(params: {
  profileId: string;
  scopes: string[];
}): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connId: `conn-${params.profileId}`,
    authenticatedUserId: `${params.profileId}@example.com`,
    authenticatedUserProfile: {
      profileId: params.profileId,
      displayName: params.profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: params.scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  };
}

async function dispatchScopedAgent(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  sessionKey?: string;
}) {
  return await withPluginRuntimeGatewayRequestScope(
    {
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
    },
    async () =>
      await dispatchGatewayMethodInProcess(
        "agent",
        {
          message: "authorization probe",
          idempotencyKey: "authorization-probe",
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        },
        { disableSyntheticClient: true, requireScopedClient: true },
      ),
  );
}

describe("typed in-process agent authorization", () => {
  beforeEach(() => {
    startTurn.mockReset();
  });

  it("rejects a scoped agent turn without operator.write", async () => {
    await expect(
      dispatchScopedAgent({
        client: createOperatorClient({ profileId: "reader", scopes: ["operator.read"] }),
        context: createContext(),
      }),
    ).rejects.toThrow("missing scope: operator.write");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects a nonparticipant agent turn before preflight", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:private-draft";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-draft-session",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", id: "owner" },
        },
      );

      await expect(
        dispatchScopedAgent({
          client: createOperatorClient({ profileId: "outsider", scopes: ["operator.write"] }),
          context: createContext(),
          sessionKey,
        }),
      ).rejects.toThrow("session is draft for this connection");
      expect(startTurn).not.toHaveBeenCalled();
    });
  });
});
