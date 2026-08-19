import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn,
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
  caps?: string[];
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
      ...(params.caps ? { caps: params.caps } : {}),
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
  return await dispatchScopedMethod({
    client: params.client,
    context: params.context,
    method: "agent",
    params: {
      message: "authorization probe",
      idempotencyKey: "authorization-probe",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
  });
}

async function dispatchScopedMethod(params: {
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  method: "agent" | "agent.wait";
  params: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return await withPluginRuntimeGatewayRequestScope(
    {
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
    },
    async () =>
      await dispatchGatewayMethodInProcess(params.method, params.params, {
        disableSyntheticClient: true,
        requireScopedClient: true,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
  );
}

describe("typed in-process agent authorization", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
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
      await upsertSessionEntryCore(
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

  it("rejects invalid agent params before preflight", async () => {
    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method: "agent",
        params: {
          message: "validation probe",
          idempotencyKey: "validation-probe",
          sessionKey: 42,
        },
      }),
    ).rejects.toThrow("invalid agent params:");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects invalid agent.wait params before lifecycle lookup", async () => {
    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method: "agent.wait",
        params: { runId: 42 },
      }),
    ).rejects.toThrow("invalid agent.wait params:");
    expect(waitForTurn).not.toHaveBeenCalled();
  });

  it("registers tool-event observation for a capable scoped client", async () => {
    const context = createContext();
    context.registerToolEventRecipient = vi.fn();
    startTurn.mockImplementation(async ({ io, onRunObserved }) => {
      onRunObserved?.("observed-run");
      io.emitAcceptance([true, { runId: "observed-run", status: "accepted" }, undefined]);
    });

    await dispatchScopedAgent({
      client: createOperatorClient({
        caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
        profileId: "tool-observer",
        scopes: ["operator.write"],
      }),
      context,
    });

    expect(context.registerToolEventRecipient).toHaveBeenCalledWith(
      "observed-run",
      "conn-tool-observer",
    );
  });

  it.each([
    ["agent", { message: "cancelled", idempotencyKey: "cancelled-agent" }],
    ["agent.wait", { runId: "cancelled-run" }],
  ] as const)("rejects a pre-aborted %s request before agent work", async (method, params) => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(
      dispatchScopedMethod({
        client: createOperatorClient({ profileId: "writer", scopes: ["operator.write"] }),
        context: createContext(),
        method,
        params,
        signal: controller.signal,
      }),
    ).rejects.toThrow("already aborted");
    expect(startTurn).not.toHaveBeenCalled();
    expect(waitForTurn).not.toHaveBeenCalled();
  });
});
