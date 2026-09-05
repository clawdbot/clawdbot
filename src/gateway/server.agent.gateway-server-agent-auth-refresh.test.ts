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

const rpcDrains: Array<Promise<PromiseSettledResult<AgentRpcFrame>[]>> = [];

function sendAgentRpc(socket: WebSocket, params: { agentId: string; runId: string }) {
  let responseReceived = false;
  const response = onceMessage<AgentRpcFrame>(socket, (frame) => {
    if (frame.type !== "res" || frame.id !== params.runId) {
      return false;
    }
    responseReceived = true;
    return true;
  });
  const final = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status !== "accepted",
  );
  // Observe both listeners immediately, then drain them before the shared server resets.
  rpcDrains.push(Promise.allSettled([response, final]));
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
  return { response, final, hasResponse: () => responseReceived };
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

  afterEach(async () => {
    try {
      const outcomes = await Promise.all(rpcDrains.splice(0));
      expect(outcomes.flat().every((outcome) => outcome.status === "fulfilled")).toBe(true);
    } finally {
      testState.agentsConfig = undefined;
    }
  });

  test("keeps an accepted run on its admitted runtime generation", async () => {
    const affectedAgentId = "auth-pinned";
    const admittedRunId = "idem-agent-auth-admitted";
    const subsequentRunId = "idem-agent-auth-next";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    expect(before.runtime).toBeDefined();
    const preparedRuntime = await import("../agents/prepared-model-runtime.js");
    const acquireRuntime = preparedRuntime.acquireAgentRunPreparedModelRuntime;
    const admittedSnapshots: Array<Awaited<ReturnType<typeof acquireRuntime>>["snapshot"]> = [];
    // Admission can derive a selected snapshot from the configured generation. Capture
    // the actual lease before ACK, then prove refresh cannot replace that run's identity.
    const acquireSpy = vi
      .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
      .mockImplementation(async (input, options) => {
        const lease = await acquireRuntime(input, options);
        if (input.agentId === affectedAgentId) {
          admittedSnapshots.push(lease.snapshot);
        }
        return lease;
      });
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
      const admitted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: admittedRunId,
      });
      await expect(admitted.response).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
      await expect(
        Promise.race([dispatchEntered.promise, admitted.final]),
      ).resolves.toBeUndefined();
      expect(agentCommandCallsFor(admittedRunId)).toHaveLength(0);
      expect(admittedSnapshots.length).toBe(1);
      const admittedSnapshot = admittedSnapshots[0];
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

      const subsequent = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: subsequentRunId,
      });
      await expect(subsequent.response).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
      await expect(subsequent.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(agentCommandCallsFor(subsequentRunId)[0]?.[4]).toMatchObject({
        config: after?.config,
        pluginGeneration: after?.pluginGeneration,
      });
      expect(admittedSnapshots.length).toBe(2);
      // Auth refresh may reuse metadata and plugin identities, but the next lease is new.
      expect(admittedSnapshots[1] === admittedSnapshot).toBe(false);
      expect(dispatchedSnapshots.get(subsequentRunId) === admittedSnapshots[1]).toBe(true);
    } finally {
      releaseDispatch.resolve();
      unregister();
      yieldSpy.mockRestore();
      acquireSpy.mockRestore();
      agentCommandMock.mockImplementation(originalCommand!);
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

      const aborted = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: abortedRunId,
      });
      const waiting = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: waitingRunId,
      });
      const sibling = sendAgentRpc(gatewaySuite.ws, { agentId: "main", runId: siblingRunId });
      await expect(sibling.response).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
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
      expect(waiting.hasResponse()).toBe(false);

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
      await expect(subsequent.response).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
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

      const rejected = sendAgentRpc(gatewaySuite.ws, {
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
