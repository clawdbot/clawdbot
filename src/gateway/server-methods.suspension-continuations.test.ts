import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { QuestionManager } from "./question-manager.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleNodeInvokeProgress } from "./server-methods/nodes.handlers.invoke-progress.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

afterEach(resetGatewayWorkAdmission);

const completionDrainModes = ["suspension", "restart signal", "restart drain"] as const;

function closeAdmission(mode: (typeof completionDrainModes)[number]) {
  if (mode === "restart signal") {
    expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
    return undefined;
  }
  if (mode === "restart drain") {
    markGatewayRestartDraining();
    return undefined;
  }
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.drain()).toBe(true);
  return suspension;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createClient(role: "operator" | "node", connId = "conn-live"): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role,
      scopes: role === "operator" ? ["operator.admin"] : [],
      client: {
        id: role === "node" ? "node-1" : "cli",
        version: "test",
        platform: "test",
        mode: role,
      },
      ...(role === "node"
        ? {
            device: {
              id: "node-1",
              publicKey: "key",
              signature: "sig",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
  } as unknown as GatewayWsClient;
}

function createContext(owners: {
  nodeRegistry?: NodeRegistry;
  execApprovalManager?: ExecApprovalManager;
  questionManager?: QuestionManager;
}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), debug: vi.fn() },
    ...owners,
  } as unknown as GatewayRequestContext;
}

async function dispatch(params: {
  method: string;
  requestParams: Record<string, unknown>;
  context: GatewayRequestContext;
  client: GatewayWsClient;
  handler: GatewayRequestHandler;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${params.method}`,
      method: params.method,
      params: params.requestParams,
    },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: params.context,
    methodRegistry: createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "suspension-continuation-proof",
        name: params.method,
        handler: params.handler,
        scope: "operator.admin",
      }),
    ]),
  });
  return respond;
}

async function createLifecycleInvoke() {
  const client = createClient("node");
  client.connect.client.id = GATEWAY_CLIENT_IDS.NODE_HOST;
  client.connect.commands = [NODE_WORKER_ENVIRONMENT_STOP_COMMAND];
  let generation = "generation-live";
  let ownerActive = true;
  const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
    createNodeRegistryRuntime(
      () =>
        new NodeRegistry({
          resolveCurrentPairingState: async () => ({ identity: "paired", generation }),
        }),
    );
  registry.register(client, { pairingIdentity: "paired", pairingGeneration: generation });
  updateNodeRunnerInventory({
    registry,
    nodeId: "node-1",
    connId: client.connId,
    declaration: {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity: { total: 1, available: 1 }, environmentSession: 1 },
    },
  });
  const [node] = await transport.listCurrentNodes();
  if (!node) {
    throw new Error("expected current worker supervisor");
  }
  const ready = deferred<string>();
  const abort = new AbortController();
  const result = transport.invoke({
    node,
    command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
    params: { environmentId: "environment-owned", sessionId: "session-owned", ownerEpoch: 1 },
    timeoutMs: 60_000,
    signal: abort.signal,
    isDispatchAuthorized: () => ownerActive,
    onDispatchReady: ready.resolve,
  });
  const invokeId = await Promise.race([
    ready.promise,
    result.then(() => {
      throw new Error("lifecycle invocation finished before dispatch");
    }),
  ]);
  const context = createContext({ nodeRegistry: registry });
  return {
    client,
    context,
    invokeId,
    registry,
    result,
    closeOwner: () => {
      ownerActive = false;
    },
    rotatePairing: () => {
      const previous = generation;
      generation = "generation-next";
      registry.updateSurface(
        "node-1",
        { commands: [NODE_WORKER_ENVIRONMENT_STOP_COMMAND] },
        {
          expectedConnId: client.connId,
          expectedPairingIdentity: "paired",
          expectedPairingGeneration: previous,
          nextPairingGeneration: generation,
        },
      );
    },
    finish: async () => {
      abort.abort();
      registry.unregister(client.connId);
      await result;
    },
  };
}

function resultRequest(invokeId: string) {
  return { id: invokeId, nodeId: "node-1", ok: true, payloadJSON: "null" };
}

describe("draining Gateway completion ownership", () => {
  it.each(["exec.approval.resolve", "approval.resolve"] as const)(
    "admits only an exact live approval continuation through %s",
    async (method) => {
      const manager = new ExecApprovalManager();
      const client = createClient("operator");
      const context = createContext({ execApprovalManager: manager });
      const ownerReady = deferred();
      const root = tryBeginGatewayRootWorkAdmission();
      if (!root) {
        throw new Error("expected admitted approval owner");
      }
      const owner = root
        .run(async () => {
          const record = manager.create({ command: "echo ok" }, 60_000, "approval-owned");
          const decision = manager.register(record, 60_000);
          ownerReady.resolve();
          return await decision;
        })
        .finally(root.release);
      await ownerReady.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        respond(true, { applied: manager.resolve("approval-owned", "allow-once") });
      });
      const shape = method === "approval.resolve" ? { kind: "exec", decision: "allow-once" } : {};

      const wrong = await dispatch({
        method,
        requestParams: { id: "approval-unrelated", ...shape },
        context,
        client,
        handler,
      });
      expect(wrong).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(handler).not.toHaveBeenCalled();

      const accepted = await dispatch({
        method,
        requestParams: { id: "approval-owned", ...shape },
        context,
        client,
        handler,
      });
      expect(accepted).toHaveBeenCalledWith(true, { applied: true });
      await expect(owner).resolves.toBe("allow-once");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    },
  );

  it("admits exact question inspection and resolution without admitting unrelated roots", async () => {
    const manager = new QuestionManager();
    const client = createClient("operator");
    const context = createContext({ questionManager: manager });
    const root = tryBeginGatewayRootWorkAdmission();
    if (!root) {
      throw new Error("expected admitted question owner");
    }
    await root.run(async () => {
      manager.request({
        id: "question-owned",
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Continue?",
            options: [],
            isOther: true,
          },
        ],
        timeoutMs: 60_000,
      });
    });
    root.release();
    // question.request returns before question.waitAnswer begins. The pending
    // question itself retains the exact admitted root across that RPC boundary.
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.drain()).toBe(true);

    const inspected = await dispatch({
      method: "question.get",
      requestParams: { id: "question-owned" },
      context,
      client,
      handler: ({ respond }) => respond(true, { question: manager.get("question-owned") }),
    });
    expect(inspected).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ question: expect.any(Object) }),
    );

    const unrelated = await dispatch({
      method: "question.resolve",
      requestParams: { id: "question-unrelated" },
      context,
      client,
      handler: vi.fn(),
    });
    expect(unrelated).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );

    const answered = await dispatch({
      method: "question.resolve",
      requestParams: { id: "question-owned" },
      context,
      client,
      handler: ({ respond }) => {
        respond(true, manager.resolve("question-owned", { answers: { choice: ["yes"] } }));
      },
    });
    expect(answered).toHaveBeenCalledWith(true, {
      status: "answered",
      answers: { answers: { choice: ["yes"] } },
    });
    expect(manager.get("question-owned")).toMatchObject({ status: "answered" });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
    manager.reset();
  });

  it.each(completionDrainModes)(
    "admits only the registered node's exact live progress and result during %s",
    async (mode) => {
      const node = createClient("node");
      const registry = new NodeRegistry({
        resolveCurrentPairingState: async () => ({
          identity: "paired",
          generation: "generation-live",
        }),
      });
      registry.register(node, {
        pairingIdentity: "paired",
        pairingGeneration: "generation-live",
      });
      const context = createContext({ nodeRegistry: registry });
      const invokeReady = deferred<string>();
      const finishDelivery = deferred();
      const chunks: string[] = [];
      const root = tryBeginGatewayRootWorkAdmission();
      if (!root) {
        throw new Error("expected admitted node invocation owner");
      }
      const owner = root
        .run(async () => {
          const result = await registry.invoke({
            nodeId: "node-1",
            command: "debug.ping",
            timeoutMs: 60_000,
            onProgress: (chunk) => chunks.push(chunk),
            onDispatchReady: invokeReady.resolve,
          });
          await finishDelivery.promise;
          return result;
        })
        .finally(root.release);
      const invokeId = await Promise.race([
        invokeReady.promise,
        owner.then(() => {
          throw new Error("node invocation finished before its dispatch became ready");
        }),
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      const suspension = closeAdmission(mode);

      try {
        const ignored = await dispatch({
          method: "node.invoke.result",
          requestParams: { id: "unrelated-invoke", nodeId: "node-1", ok: true },
          context,
          client: node,
          handler: vi.fn(),
        });
        expect(ignored).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );

        const malformed = await dispatch({
          method: "node.invoke.progress",
          requestParams: { invokeId, nodeId: "node-1", seq: -1, chunk: "invalid" },
          context,
          client: node,
          handler: handleNodeInvokeProgress,
        });
        expect(malformed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(chunks).toEqual([]);
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        const progressed = await dispatch({
          method: "node.invoke.progress",
          requestParams: { invokeId, nodeId: "node-1", seq: 0, chunk: "working" },
          context,
          client: node,
          handler: handleNodeInvokeProgress,
        });
        expect(progressed).toHaveBeenCalledWith(true, { ok: true, ignored: false }, undefined);
        expect(chunks).toEqual(["working"]);

        const completed = await dispatch({
          method: "node.invoke.result",
          requestParams: {
            id: invokeId,
            nodeId: "node-1",
            ok: true,
            payloadJSON: null,
            error: null,
          },
          context,
          client: node,
          handler: handleNodeInvokeResult,
        });
        expect(completed).toHaveBeenCalledWith(true, { ok: true }, undefined);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        finishDelivery.resolve();
        await expect(owner).resolves.toMatchObject({ ok: true, payloadJSON: null, error: null });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (suspension) {
          expect(suspension.release()).toBe(true);
        }
      } finally {
        finishDelivery.resolve();
        registry.unregister(node.connId);
        await owner;
      }
    },
  );
});

describe("restart lifecycle completion ownership", () => {
  it.each(["restart signal", "restart drain"] as const)(
    "settles newly dispatched lifecycle cleanup during %s without admitting another root",
    async (mode) => {
      closeAdmission(mode);
      const invoke = await createLifecycleInvoke();
      try {
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        const progressed = await dispatch({
          method: "node.invoke.progress",
          requestParams: { invokeId: invoke.invokeId, nodeId: "node-1", seq: 0, chunk: "stopped" },
          context: invoke.context,
          client: invoke.client,
          handler: handleNodeInvokeProgress,
        });
        // Lifecycle invokes have no stream consumer, but authenticated progress
        // still records execution and prevents a contradictory not-ready replay.
        expect(progressed).toHaveBeenCalledWith(true, { ok: true, ignored: true }, undefined);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
        const completed = await dispatch({
          method: "node.invoke.result",
          requestParams: {
            ...resultRequest(invoke.invokeId),
            ok: false,
            error: { code: "NODE_NOT_READY", message: "not ready" },
          },
          context: invoke.context,
          client: invoke.client,
          handler: handleNodeInvokeResult,
        });
        expect(completed).toHaveBeenCalledWith(true, { ok: true }, undefined);
        await expect(invoke.result).resolves.toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "node reported not-ready after invocation progress",
          },
        });
        const replayed = await dispatch({
          method: "node.invoke.result",
          requestParams: resultRequest(invoke.invokeId),
          context: invoke.context,
          client: invoke.client,
          handler: handleNodeInvokeResult,
        });
        expect(replayed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      } finally {
        await invoke.finish();
      }
    },
  );

  it.each(["invoke", "node", "connection", "pairing", "owner"] as const)(
    "rejects lifecycle completion after its %s identity no longer matches",
    async (changed) => {
      closeAdmission("restart drain");
      const invoke = await createLifecycleInvoke();
      try {
        const request = resultRequest(invoke.invokeId);
        let client = invoke.client;
        if (changed === "invoke") {
          request.id = "unrelated-invoke";
        } else if (changed === "node") {
          request.nodeId = "unrelated-node";
        } else if (changed === "connection") {
          client = { ...invoke.client, connId: "replaced-connection" };
        } else if (changed === "pairing") {
          invoke.rotatePairing();
        } else {
          invoke.closeOwner();
        }
        const rejected = await dispatch({
          method: "node.invoke.result",
          requestParams: request,
          context: invoke.context,
          client,
          handler: handleNodeInvokeResult,
        });
        expect(rejected).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        await invoke.finish();
      }
    },
  );

  it("rechecks the lifecycle owner at result settlement after awaited dispatch work", async () => {
    closeAdmission("restart drain");
    const invoke = await createLifecycleInvoke();
    const enteredHandler = deferred();
    const resumeHandler = deferred();
    try {
      const response = dispatch({
        method: "node.invoke.result",
        requestParams: resultRequest(invoke.invokeId),
        context: invoke.context,
        client: invoke.client,
        handler: async (options) => {
          enteredHandler.resolve();
          await resumeHandler.promise;
          expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
          await handleNodeInvokeResult(options);
        },
      });
      await Promise.race([
        enteredHandler.promise,
        response.then(() => {
          throw new Error("lifecycle completion was rejected before reaching its handler");
        }),
      ]);
      invoke.closeOwner();
      resumeHandler.resolve();
      expect(await response).toHaveBeenCalledWith(true, { ok: true, ignored: true }, undefined);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      resumeHandler.resolve();
      await invoke.finish();
    }
  });
});
