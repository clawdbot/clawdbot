import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-auth-refresh-", {
  client: {
    id: "gateway-client",
    version: "1.0.0",
    platform: "test",
    mode: "backend",
  },
});

type AgentRpcFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: {
    runId?: string;
    status?: string;
    stopReason?: string;
    timeoutPhase?: string;
    providerStarted?: boolean;
  };
  error?: { code?: string; message?: string };
};

function sendAgentRpc(socket: WebSocket, params: { agentId: string; runId: string }) {
  const accepted = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status === "accepted",
  );
  const final = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status !== "accepted",
  );
  socket.send(
    JSON.stringify({
      type: "req",
      id: params.runId,
      method: "agent",
      params: {
        agentId: params.agentId,
        message: `dispatch ${params.runId}`,
        idempotencyKey: params.runId,
      },
    }),
  );
  return { accepted, final };
}

function agentCommandCallsFor(runId: string) {
  return vi
    .mocked(agentCommandMock)
    .mock.calls.filter(([options]) => (options as { runId?: string }).runId === runId);
}

async function prepareAuthDispatchAgents(affectedAgentId: string) {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: affectedAgentId }],
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "claude-opus-4-6", provider: "anthropic", input: ["text"] }];
  const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
    await import("../config/io.js");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await prepareGatewayReplyRuntimeForTest({ force: true });
  const config = getRuntimeConfig();
  return {
    agentDir: resolveAgentDir(config, affectedAgentId),
    runtime: await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
  };
}

describe("gateway agent auth refresh dispatch", () => {
  beforeEach(() => {
    vi.mocked(agentCommandMock).mockClear();
  });

  afterEach(() => {
    testState.agentsConfig = undefined;
  });

  test("aborts one affected waiter without cancelling shared auth publication", async () => {
    const affectedAgentId = "auth-wait";
    const abortedRunId = "idem-agent-auth-aborted";
    const waitingRunId = "idem-agent-auth-waiting";
    const siblingRunId = "idem-agent-auth-sibling";
    const subsequentRunId = "idem-agent-auth-subsequent";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const activeWorkBefore = getActiveGatewayRootWorkCount();
    const publicationGate = createDeferred<{ agentDir: string; wrote: false }>();
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) =>
        agentDir === before.agentDir
          ? await publicationGate.promise
          : await ensureOpenClawModelsJson(config, agentDir, options),
      );
    const published = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        published.resolve();
      }
    });
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "fresh-generation-key",
            },
          },
        },
        before.agentDir,
      );

      const aborted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: abortedRunId,
      });
      const waiting = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: waitingRunId,
      });
      await Promise.all([aborted.accepted, waiting.accepted]);
      const sibling = sendAgentRpc(gatewaySuite.ws, { agentId: "main", runId: siblingRunId });
      await sibling.accepted;
      await expect(sibling.final).resolves.toMatchObject({ ok: true, payload: { status: "ok" } });
      expect(agentCommandCallsFor(siblingRunId)).toHaveLength(1);
      expect(agentCommandCallsFor(abortedRunId)).toHaveLength(0);
      expect(agentCommandCallsFor(waitingRunId)).toHaveLength(0);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(activeWorkBefore + 2));

      const abort = await rpcReq(gatewaySuite.ws, "chat.abort", {
        sessionKey: `agent:${affectedAgentId}:main`,
        runId: abortedRunId,
      });
      expect(abort).toMatchObject({
        ok: true,
        payload: { aborted: true, runIds: [abortedRunId] },
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(activeWorkBefore + 1));
      await expect(aborted.final).resolves.toMatchObject({
        ok: true,
        payload: {
          status: "timeout",
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
        },
      });
      await expect(
        Promise.race([waiting.final.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      await published.promise;
      const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId });
      expect(after).not.toBe(before.runtime);
      await expect(waiting.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      const affectedCalls = agentCommandCallsFor(waitingRunId);
      expect(affectedCalls).toHaveLength(1);
      expect(affectedCalls[0]?.[4]).toMatchObject({
        config: after?.config,
        pluginGeneration: after?.pluginGeneration,
      });
      const subsequent = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: subsequentRunId,
      });
      await subsequent.accepted;
      await expect(subsequent.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(agentCommandCallsFor(subsequentRunId)).toHaveLength(1);
    } finally {
      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      unregister();
      ensureSpy.mockRestore();
    }
  });

  test("never reuses an affected projection after auth publication rejects", async () => {
    const affectedAgentId = "auth-reject";
    const runId = "idem-agent-auth-reject";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) => {
        if (agentDir === before.agentDir) {
          throw new Error("auth publication rejected");
        }
        return await ensureOpenClawModelsJson(config, agentDir, options);
      });
    const failed = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "failed") {
        failed.resolve();
      }
    });
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "rejected-generation-key",
            },
          },
        },
        before.agentDir,
      );
      await failed.promise;
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
      ).rejects.toThrow(
        `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
      );

      const dispatched = sendAgentRpc(gatewaySuite.ws, { agentId: affectedAgentId, runId });
      await expect(dispatched.accepted).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
      await expect(dispatched.final).resolves.toMatchObject({
        ok: false,
        payload: { status: "error" },
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining(
            `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
          ),
        },
      });
      expect(agentCommandCallsFor(runId)).toHaveLength(0);
    } finally {
      unregister();
      ensureSpy.mockRestore();
    }
  });
});
