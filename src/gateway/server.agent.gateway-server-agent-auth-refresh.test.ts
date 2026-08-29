import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../agents/prepared-model-runtime-generation-scope.js";
import {
  getPreparedModelRuntimeSnapshot,
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

function sendPreacceptAgentRpc(socket: WebSocket, params: { agentId: string; runId: string }) {
  const response = onceMessage<AgentRpcFrame>(
    socket,
    (frame) => frame.type === "res" && frame.id === params.runId,
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
  return { response, final };
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

  test("keeps an accepted run on its admitted runtime generation", async () => {
    const affectedAgentId = "auth-pinned";
    const admittedRunId = "idem-agent-auth-admitted";
    const subsequentRunId = "idem-agent-auth-next";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    expect(before.runtime).toBeDefined();
    const snapshotInput = {
      agentId: affectedAgentId,
      agentDir: before.agentDir,
      config: before.runtime!.config,
      workspaceDir: before.runtime!.workspaceDir,
      allowGatewaySubagentBinding: true,
    };
    const dispatchedSnapshots = new Map<
      string,
      ReturnType<typeof getPreparedModelRuntimeBorrowedSnapshot>
    >();
    const originalCommand = agentCommandMock.getMockImplementation();
    expect(originalCommand).toBeDefined();
    const dispatchEntered = createDeferred();
    const releaseDispatch = createDeferred();
    const handlerHelpers = await import("./agent-turn/agent-handler-helpers.js");
    // Receiving the ACK is not a barrier against the server's dispatch timer.
    const yieldSpy = vi
      .spyOn(handlerHelpers, "yieldAfterAgentAcceptedAck")
      .mockImplementationOnce(() => {
        dispatchEntered.resolve();
        return releaseDispatch.promise;
      });
    const published = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        published.resolve();
      }
    });
    let admitted: ReturnType<typeof sendAgentRpc> | undefined;
    let subsequent: ReturnType<typeof sendAgentRpc> | undefined;
    try {
      agentCommandMock.mockImplementation((options, ...args) => {
        if (
          !options ||
          typeof options !== "object" ||
          !("runId" in options) ||
          typeof options.runId !== "string"
        ) {
          throw new Error("Expected an agent command with a run ID");
        }
        const generation = getPreparedModelRuntimePluginGeneration();
        dispatchedSnapshots.set(
          options.runId,
          generation ? getPreparedModelRuntimeBorrowedSnapshot(generation) : undefined,
        );
        return originalCommand!(options, ...args);
      });
      admitted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: admittedRunId,
      });
      await admitted.accepted;
      await expect(
        Promise.race([dispatchEntered.promise, admitted.final]),
      ).resolves.toBeUndefined();
      expect(agentCommandCallsFor(admittedRunId)).toHaveLength(0);
      const admittedSnapshot = getPreparedModelRuntimeSnapshot(snapshotInput);
      expect(admittedSnapshot).toBeDefined();

      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "next-generation-key",
            },
          },
        },
        before.agentDir,
      );
      await expect(Promise.race([published.promise, admitted.final])).resolves.toBeUndefined();
      const after = await loadPublishedGatewayReplyDispatchRuntime({
        agentId: affectedAgentId,
      });
      expect(after).not.toBe(before.runtime);
      const refreshedSnapshot = getPreparedModelRuntimeSnapshot(snapshotInput);
      expect(refreshedSnapshot).toBeDefined();
      // Auth refresh can reuse config and plugin identities; the leased snapshot must differ.
      expect(refreshedSnapshot === admittedSnapshot).toBe(false);
      expect(agentCommandCallsFor(admittedRunId)).toHaveLength(0);
      releaseDispatch.resolve();

      await expect(admitted.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(agentCommandCallsFor(admittedRunId)[0]?.[4]).toMatchObject({
        config: before.runtime?.config,
        pluginGeneration: before.runtime?.pluginGeneration,
      });
      expect(dispatchedSnapshots.get(admittedRunId) === admittedSnapshot).toBe(true);

      subsequent = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: subsequentRunId,
      });
      await subsequent.accepted;
      await expect(subsequent.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(agentCommandCallsFor(subsequentRunId)[0]?.[4]).toMatchObject({
        config: after?.config,
        pluginGeneration: after?.pluginGeneration,
      });
      expect(dispatchedSnapshots.get(subsequentRunId) === refreshedSnapshot).toBe(true);
    } finally {
      releaseDispatch.resolve();
      unregister();
      try {
        // Drain this test's real RPC listeners before shared-server fixtures reset.
        await Promise.allSettled([
          ...(admitted ? [admitted.accepted, admitted.final] : []),
          ...(subsequent ? [subsequent.accepted, subsequent.final] : []),
        ]);
      } finally {
        yieldSpy.mockRestore();
        agentCommandMock.mockImplementation(originalCommand!);
      }
    }
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

      const aborted = sendPreacceptAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: abortedRunId,
      });
      const waiting = sendPreacceptAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: waitingRunId,
      });
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
      await expect(aborted.response).resolves.toMatchObject({
        ok: true,
        payload: {
          status: "timeout",
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
        },
      });
      await expect(
        Promise.race([waiting.response.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      await published.promise;
      const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId });
      expect(after).not.toBe(before.runtime);
      await expect(waiting.response).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
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

      const rejected = sendPreacceptAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId,
      });
      await expect(rejected.response).resolves.toMatchObject({
        ok: false,
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
