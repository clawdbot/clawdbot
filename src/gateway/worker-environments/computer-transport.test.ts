import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../../infra/node-commands.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  createApprovalClientLookup,
  createOperatorClient,
  expectSinglePendingApproval,
} from "../node-invoke-plugin-policy.test-helpers.js";
import { createWorkerComputerService } from "./computer-transport.js";
import {
  COMPUTER_USE,
  EXECUTION_ID,
  NEXT_EXECUTION_ID,
  createHarness,
  connectionIdentity,
  type Harness,
} from "./computer-transport.test-support.js";
import { createWorkerComputerRpc } from "./worker-turn-computer-rpc.js";

function request(
  action: "snapshot" | "type" | "close",
  executionId = EXECUTION_ID,
): Parameters<ComputerToolTransport["invoke"]>[0] {
  return {
    nodeId: "desktop-node",
    command: action === "snapshot" ? "screen.snapshot" : "computer.act",
    commandParams:
      action === "snapshot"
        ? { executionId, format: "png" }
        : action === "close"
          ? { executionId, action: "__close_execution", reason: "completion" }
          : { executionId, action: "type", text: "session desktop only" },
  };
}

const revocations: Array<{ name: string; revoke(harness: Harness): void }> = [
  { name: "turn claim", revoke: (h) => h.releaseClaim() },
  {
    name: "lease",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, leaseId: "replacement" };
    },
  },
  {
    name: "owner epoch",
    revoke: (h) => {
      h.state.environment = { ...h.state.environment, ownerEpoch: 8 };
    },
  },
  {
    name: "node connection",
    revoke: (h) => {
      h.state.node = { ...h.state.node, connId: "replacement" };
    },
  },
  {
    name: "node pairing",
    revoke: (h) => {
      h.state.node = { ...h.state.node, pairingGeneration: "replacement" };
    },
  },
  {
    name: "private runner proof",
    revoke: (h) => {
      h.state.privateCurrent = false;
    },
  },
  {
    name: "operational run",
    revoke: (h) => {
      claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef(h.claim.runId));
    },
  },
  {
    name: "Gateway lifecycle",
    revoke: () => {
      rotateAgentRunRegistryLifecycleGeneration();
    },
  },
  {
    name: "Gateway context",
    revoke: (h) => {
      h.state.context = undefined;
    },
  },
  {
    name: "plugin registry",
    revoke: () => setActivePluginRegistry(createEmptyPluginRegistry()),
  },
  {
    name: "plugin policy",
    revoke: (h) => {
      h.registry.nodeInvokePolicies.splice(0);
    },
  },
  {
    name: "plugin lifecycle",
    revoke: (h) => {
      h.registry.plugins[0]!.enabled = false;
    },
  },
];

describe("session computer transport", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
  });

  it("routes snapshots and classified input to the exact private node without public fallback", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    expect(transport.computerUse).toEqual(COMPUTER_USE);
    await expect(transport.resolveNode()).resolves.toMatchObject({ nodeId: "desktop-node" });
    await transport.invoke(request("snapshot"));
    await transport.invoke(request("type"));
    const physicalId = h.nativeExecutionIds[0];
    expect(physicalId).not.toBe(EXECUTION_ID);
    expect(h.privateInvoke.mock.calls.map(([call]) => call.params)).toEqual([
      { operation: "capabilities" },
      {
        operation: "snapshot",
        providerGeneration: COMPUTER_USE.provider.generation,
        params: { ...request("snapshot").commandParams, executionId: physicalId },
      },
      {
        operation: "act",
        providerGeneration: COMPUTER_USE.provider.generation,
        params: { ...request("type").commandParams, executionId: physicalId },
      },
    ]);
    expect(
      h.privateInvoke.mock.calls.every(
        ([call]) =>
          call.node.nodeId === "desktop-node" &&
          call.command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
      ),
    ).toBe(true);
    expect(h.classifyRisk).toHaveBeenCalledWith({
      command: "computer.act",
      params: { ...request("type").commandParams, executionId: physicalId },
    });
    expect(h.policyHandle.mock.calls[0]?.[0].risk).toEqual({
      level: "ordinary",
      family: "fixture_input",
    });
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each([true, false])(
    "uses a shared paired node's approved public capability (plugin policy: %s)",
    async (withPolicy) => {
      const h = createHarness(true, withPolicy);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      await transport.invoke(request("type"));
      expect(h.nodeTransport.listCurrentNodes).not.toHaveBeenCalled();
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).toHaveBeenLastCalledWith(
        expect.objectContaining({
          nodeId: "desktop-node",
          expectedConnId: "desktop-connection",
          expectedPairingGeneration: "pairing-1",
          command: "computer.act",
          params: { ...request("type").commandParams, executionId: h.nativeExecutionIds[0] },
        }),
      );
      await prepared.close("completion");
    },
  );

  it("rejects foreign targets and execution IDs without dispatching or selecting another node", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await expect(transport.resolveNode("other-desktop")).rejects.toThrow(/bound/);
    await expect(transport.invoke({ ...request("type"), nodeId: "other-desktop" })).rejects.toThrow(
      /bound/,
    );
    await transport.invoke(request("snapshot"));
    h.privateInvoke.mockClear();
    await expect(transport.invoke(request("type", NEXT_EXECUTION_ID))).rejects.toThrow(
      /execution owner changed/,
    );
    await expect(transport.invoke(request("close", NEXT_EXECUTION_ID))).rejects.toThrow(
      /execution owner changed/,
    );
    expect(h.privateInvoke).not.toHaveBeenCalled();
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each([false, true])(
    "keeps independent bound attempts separate even when execution IDs are copied (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      const projection = prepared.bind(h.run);
      await transport.invoke(request("snapshot"));
      const firstPhysicalId = h.nativeExecutionIds[0]!;
      expect(firstPhysicalId).not.toBe(EXECUTION_ID);
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      await expect(projection.invoke(request("close", firstPhysicalId))).resolves.toEqual({
        ok: true,
      });
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await expect(projection.invoke(request("type", firstPhysicalId))).rejects.toThrow(/closed/);
      await transport.invoke(request("type"));
      expect(h.nativeExecutionIds.at(-1)).toBe(firstPhysicalId);
      await transport.invoke(request("close"));
      await expect(transport.invoke(request("snapshot"))).rejects.toThrow(/closed/);

      const next = prepared.bind(h.run);
      await next.invoke(request("snapshot", firstPhysicalId));
      expect(h.nativeExecutionIds.at(-1)).not.toBe(firstPhysicalId);
      expect(h.nativeExecutionIds.at(-1)).not.toBe(EXECUTION_ID);
      await prepared.close("completion");
    },
  );

  it("rejects a close envelope submitted as a snapshot before any node dispatch", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    h.privateInvoke.mockClear();
    await expect(
      transport.invoke({ ...request("close"), command: "screen.snapshot" }),
    ).rejects.toThrow(/invalid worker computer request/);
    expect(h.policyHandle).not.toHaveBeenCalled();
    expect(h.privateInvoke).not.toHaveBeenCalled();
    await prepared.close("completion");
  });

  it.each(["commands", "provider"] as const)(
    "honors a paired host's live %s revocation during policy work",
    async (surface) => {
      const h = createHarness(true);
      const { transport, prepared } = await h.prepare();
      h.state.beforePolicy = async () => {
        await Promise.resolve();
        if (surface === "commands") {
          h.state.node.commands = [];
        } else {
          h.state.node.computerUse = {
            ...COMPUTER_USE,
            provider: { ...COMPUTER_USE.provider, generation: "provider-2" },
          };
        }
      };
      await expect(transport.invoke(request("type"))).rejects.toThrow();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      h.state.node.commands = ["screen.snapshot", "computer.act"];
      h.state.beforePolicy = undefined;
      await prepared.close("completion");
    },
  );

  it("keeps session and live run authority on clientless policy approvals", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) &&
        (authority.kind === "local" || h.options.placements.validateTurnClaim(authority.turnClaim)),
    });
    const context = h.state.context!;
    context.pluginApprovalManager = manager;
    context.getApprovalClientConnIds = createApprovalClientLookup([createOperatorClient()]);
    h.policyHandle.mockImplementationOnce(async (policy) => {
      const approval = await policy.approvals?.request({
        title: "Session desktop action",
        description: "Approve the bound desktop action",
      });
      if (approval?.decision !== "allow-once") {
        return { ok: false, message: "approval required" };
      }
      return await policy.invokeNode();
    });
    const operation = transport.invoke(request("type"));
    const record = await expectSinglePendingApproval(manager);
    expect(record.request).toMatchObject({
      agentId: "main",
      sessionKey: h.state.placement.sessionKey,
      runId: h.claim.runId,
    });
    expect(record.agentRuntimeDelegatedAuthority).toMatchObject({
      kind: "worker",
      turnClaim: h.claim,
      operationalRunInstance: h.run,
    });
    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await expect(operation).resolves.toMatchObject({ ok: true });
    expect(manager.getSnapshot(record.id)?.consumedDecision).toBe("allow-once");
    releaseAgentRunDelegatedAuthority(h.authority);
    h.releaseClaim();
    h.policyHandle.mockClear();
    await prepared.close("completion");
    expect(h.policyHandle).not.toHaveBeenCalled();
    expect(manager.listPendingRecords()).toEqual([]);
  });

  it.each([
    { sharedHost: false, boundary: "policy" },
    { sharedHost: true, boundary: "policy" },
    { sharedHost: false, boundary: "pairing" },
    { sharedHost: true, boundary: "pairing" },
  ] as const)(
    "withholds native input when only the RPC grant closes during $boundary (shared host: $sharedHost)",
    async ({ sharedHost, boundary }) => {
      const h = createHarness(sharedHost);
      const service = createWorkerComputerService(h.options);
      const prepared = await service.prepare(h.claim);
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      prepared.bind(h.run);
      const identity = connectionIdentity(h);
      let granted = true;
      const rpc = createWorkerComputerRpc({
        execute: service.execute,
        validate: () => (granted ? { ok: true } : { ok: false, closeReason: "method-not-allowed" }),
      });
      const connection = new AbortController();
      const invoke = (action: "snapshot" | "type") => {
        const input = request(action);
        return rpc(
          identity,
          { command: input.command, paramsJson: JSON.stringify(input.commandParams) },
          connection.signal,
        );
      };
      await expect(invoke("snapshot")).resolves.toMatchObject({ ok: true });
      const physicalId = h.nativeExecutionIds[0];
      const entered = createDeferred();
      const resume = createDeferred();
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      if (boundary === "policy") {
        h.state.beforePolicy = pause;
      } else {
        h.state.beforeDispatch = pause;
      }
      const operation = invoke("type");
      await entered.promise;
      granted = false;
      expect(h.options.placements.validateTurnClaim(h.claim)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(h.authority)).toBe(true);
      resume.resolve();
      await expect(operation).resolves.toEqual({
        ok: false,
        closeReason: "method-not-allowed",
      });
      expect(h.nativeExecutionIds).toEqual([physicalId]);
      h.state.beforePolicy = undefined;
      h.state.beforeDispatch = undefined;
      await service.close();
      expect(h.nativeExecutionIds).toEqual([physicalId, physicalId]);
      const calls = sharedHost ? h.publicInvoke.mock.calls : h.privateInvoke.mock.calls;
      expect(calls.at(-1)?.[0].params).toMatchObject(
        sharedHost
          ? { action: "__close_execution", executionId: physicalId }
          : { operation: "close", executionId: physicalId },
      );
    },
  );

  it.each([
    { boundary: "policy", closeFails: false },
    { boundary: "pairing", closeFails: false },
    { boundary: "policy", closeFails: true },
    { boundary: "pairing", closeFails: true },
  ])(
    "cancels worker input during $boundary and joins cleanup (close fails: $closeFails)",
    async ({ boundary, closeFails }) => {
      const h = createHarness();
      const service = createWorkerComputerService(h.options);
      const prepared = await service.prepare(h.claim);
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      prepared.bind(h.run);
      const rpc = createWorkerComputerRpc({
        execute: service.execute,
        validate: () => ({ ok: true }),
      });
      const connection = new AbortController();
      const cleanups: Array<(reason: string) => Promise<void>> = [];
      const tool = createWorkerComputerTool({
        descriptor: prepared.descriptor,
        runId: h.claim.runId,
        registerRunCleanup: (cleanup) => cleanups.push(cleanup),
        requestComputer: async (input) => {
          const result = await rpc(connectionIdentity(h), input, connection.signal);
          return result.ok
            ? { type: "res", id: "computer", ok: true, payload: result.result }
            : {
                type: "res",
                id: "computer",
                ok: false,
                error: {
                  code: "UNAVAILABLE",
                  message: "computer request rejected",
                  details: { reason: "gateway-unavailable" },
                },
              };
        },
      });
      const entered = createDeferred();
      const resume = createDeferred();
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      if (boundary === "policy") {
        h.state.beforePolicy = pause;
      } else {
        h.state.beforeDispatch = pause;
      }
      if (closeFails) {
        h.state.afterDispatch = async () => {
          throw new Error("native close failed");
        };
      }
      const controller = new AbortController();
      const operation = tool.execute(
        "cancelled-input",
        { action: "type", text: "must not type" },
        controller.signal,
      );
      const rejected = expect(operation).rejects.toThrow();
      await entered.promise;
      controller.abort(new Error("tool cancelled"));
      await setImmediate();
      expect(h.options.placements.validateTurnClaim(h.claim)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(h.authority)).toBe(true);
      resume.resolve();
      await rejected;
      h.state.beforePolicy = undefined;
      h.state.beforeDispatch = undefined;
      const retainedError = await tool
        .execute("retained", { action: "type", text: "still forbidden" })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const cleanup = Promise.all(cleanups.map((close) => close("finished")));
      if (closeFails) {
        await expect(cleanup).rejects.toThrow(/cleanup failed/);
        await expect(service.close()).rejects.toThrow(/cleanup failed/);
      } else {
        await cleanup;
        await service.close();
      }
      expect(h.nativeExecutionIds).toHaveLength(1);
      expect(h.privateInvoke.mock.calls.at(-1)?.[0].params).toMatchObject({ operation: "close" });
      expect(retainedError).toBeInstanceOf(Error);
    },
  );

  it.each(revocations)(
    "rejects input after $name revocation while policy is pending",
    async (revocation) => {
      const h = createHarness();
      const { transport, prepared } = await h.prepare();
      const entered = createDeferredCore();
      const policy = createDeferredCore();
      h.state.beforePolicy = async () => {
        entered.resolve();
        await policy.promise;
      };
      h.privateInvoke.mockClear();
      const invoked = transport.invoke(request("type"));
      const rejected = expect(invoked).rejects.toThrow();
      await entered.promise;
      revocation.revoke(h);
      policy.resolve();
      await rejected;
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await prepared.close("cancellation");
    },
  );

  it.each(revocations)("withholds an awaited result after $name revocation", async (revocation) => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    const entered = createDeferredCore();
    const result = createDeferredCore();
    h.state.afterDispatch = async () => {
      entered.resolve();
      await result.promise;
    };
    h.privateInvoke.mockClear();
    const invoked = transport.invoke(request("type"));
    const rejected = expect(invoked).rejects.toThrow();
    await entered.promise;
    revocation.revoke(h);
    result.resolve();
    await rejected;
    expect(h.privateInvoke).toHaveBeenCalledOnce();
    expect(h.publicInvoke).not.toHaveBeenCalled();
    await prepared.close("cancellation");
  });

  it("closes only the captured execution after run and claim release, and never resumes input", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    releaseAgentRunDelegatedAuthority(h.authority);
    h.releaseClaim();
    h.privateInvoke.mockClear();
    await prepared.close("cancellation");
    await prepared.close("cancellation");
    await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    expect(h.privateInvoke).toHaveBeenCalledOnce();
    expect(h.privateInvoke.mock.calls[0]?.[0].params).toEqual({
      operation: "close",
      executionId: h.nativeExecutionIds[0],
      reason: "cancellation",
    });
  });

  it.each([
    { sharedHost: false, revoke: "policy" },
    { sharedHost: true, revoke: "policy" },
    { sharedHost: false, revoke: "commands" },
    { sharedHost: true, revoke: "commands" },
  ] as const)(
    "releases its native execution after $revoke revocation (shared host: $sharedHost)",
    async ({ sharedHost, revoke }) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      const physicalId = h.nativeExecutionIds[0];
      if (revoke === "policy") {
        setActivePluginRegistry(createEmptyPluginRegistry());
      } else {
        h.state.config = { gateway: { nodes: { commands: { deny: ["computer.act"] } } } };
      }
      await expect(transport.invoke(request("type"))).rejects.toThrow();
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockClear();

      await expect(prepared.close("revoked")).resolves.toBeUndefined();
      const nativeInvoke = sharedHost ? h.publicInvoke : h.privateInvoke;
      expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(
          sharedHost
            ? {
                command: "computer.act",
                params: { action: "__close_execution", executionId: physicalId, reason: "revoked" },
              }
            : {
                command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
                params: { operation: "close", executionId: physicalId, reason: "revoked" },
              },
        ),
      );
      expect(h.policyHandle).not.toHaveBeenCalled();
      await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    },
  );

  it.each([false, true])(
    "prevents plugin policy overrides from replacing the execution owner (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockImplementationOnce((policy) =>
        policy.invokeNode({ params: request("type", NEXT_EXECUTION_ID).commandParams }),
      );
      await expect(transport.invoke(request("type"))).rejects.toThrow(/replace.*execution owner/);
      expect(h.privateInvoke).not.toHaveBeenCalled();
      expect(h.publicInvoke).not.toHaveBeenCalled();
      await prepared.close("completion");
    },
  );

  it.each([false, true])(
    "releases owned resources without re-entering an input policy (shared host: %s)",
    async (sharedHost) => {
      const h = createHarness(sharedHost);
      const { transport, prepared } = await h.prepare();
      await transport.invoke(request("snapshot"));
      releaseAgentRunDelegatedAuthority(h.authority);
      h.releaseClaim();
      h.privateInvoke.mockClear();
      h.publicInvoke.mockClear();
      h.policyHandle.mockClear();
      h.policyHandle.mockImplementationOnce((policy) =>
        policy.invokeNode({ params: request("type").commandParams }),
      );
      await prepared.close("completion");
      expect(h.policyHandle).not.toHaveBeenCalled();
      if (sharedHost) {
        expect(h.publicInvoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            command: "computer.act",
            params: { ...request("close").commandParams, executionId: h.nativeExecutionIds[0] },
          }),
        );
        expect(h.privateInvoke).not.toHaveBeenCalled();
      } else {
        expect(h.privateInvoke).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            params: {
              operation: "close",
              executionId: h.nativeExecutionIds[0],
              reason: "completion",
            },
          }),
        );
        expect(h.publicInvoke).not.toHaveBeenCalled();
      }
    },
  );

  it.each(
    revocations.filter(({ name }) =>
      [
        "lease",
        "owner epoch",
        "node connection",
        "node pairing",
        "private runner proof",
        "Gateway context",
      ].includes(name),
    ),
  )("never sends cleanup to a replacement $name owner", async (revocation) => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    h.privateInvoke.mockClear();
    revocation.revoke(h);
    await prepared.close("completion");
    expect(h.privateInvoke).not.toHaveBeenCalled();
    expect(h.publicInvoke).not.toHaveBeenCalled();
  });

  it("allows a fresh attempt execution after the earlier execution closes normally", async () => {
    const h = createHarness();
    const { transport, prepared } = await h.prepare();
    await transport.invoke(request("snapshot"));
    await transport.invoke(request("close"));
    await expect(transport.invoke(request("type"))).rejects.toThrow(/closed/);
    await prepared.bind(h.run).invoke(request("type", NEXT_EXECUTION_ID));
    const nextPhysicalId = h.nativeExecutionIds.at(-1);
    expect(nextPhysicalId).not.toBe(h.nativeExecutionIds[0]);
    expect(nextPhysicalId).not.toBe(NEXT_EXECUTION_ID);
    await prepared.close("completion");
    expect(h.privateInvoke.mock.calls.at(-1)?.[0].params).toEqual({
      operation: "close",
      executionId: nextPhysicalId,
      reason: "completion",
    });
  });

  it.each(["claim", "shutdown"] as const)(
    "service waits for native cleanup started by %s and rejects retained handles",
    async (boundary) => {
      const h = createHarness();
      const service = createWorkerComputerService(h.options);
      const first = service.prepare(h.claim);
      expect(service.prepare(h.claim)).toBe(first);
      const prepared = await first;
      if (!prepared) {
        throw new Error("Expected a prepared session desktop");
      }
      const transport = prepared.bind(h.run);
      await transport.invoke(request("snapshot"));
      h.privateInvoke.mockClear();
      const entered = createDeferredCore();
      const released = createDeferredCore();
      h.state.afterDispatch = async () => {
        entered.resolve();
        await released.promise;
      };
      const completed: string[] = [];
      if (boundary === "claim") {
        h.releaseClaim();
        await entered.promise;
      }
      const firstStop = service.close().then(() => completed.push("first"));
      await entered.promise;
      const secondStop = service.close().then(() => completed.push("second"));
      try {
        await setImmediate();
        expect(completed).toEqual([]);
        await expect(transport.invoke(request("type"))).rejects.toThrow(/closed|replaced/);
        await expect(service.prepare(h.claim)).rejects.toThrow(/closed/);
      } finally {
        released.resolve();
        await Promise.all([firstStop, secondStop]);
      }
      expect(completed).toHaveLength(2);
      expect(h.privateInvoke.mock.calls[0]?.[0].params).toMatchObject({
        operation: "close",
        executionId: h.nativeExecutionIds[0],
      });
      await service.close();
      expect(h.privateInvoke).toHaveBeenCalledOnce();
    },
  );

  it.each(["same claim", "new claim"])(
    "keeps computer ownership on one connection and permits a fresh %s after cleanup",
    async (renewal) => {
      const h = createHarness();
      const service = createWorkerComputerService(h.options);
      const first = await service.prepare(h.claim);
      if (!first) {
        throw new Error("Expected session computer");
      }
      const retained = first.bind(h.run);
      const rpc = createWorkerComputerRpc({
        execute: service.execute,
        validate: () => ({ ok: true }),
      });
      const identity = connectionIdentity(h);
      const original = new AbortController();
      const replacement = new AbortController();
      const input = request("type");
      const frame = { command: input.command, paramsJson: JSON.stringify(input.commandParams) };
      try {
        await expect(rpc(identity, frame)).resolves.toMatchObject({
          ok: false,
          message: expect.stringContaining("start a new turn"),
        });
        expect(h.nativeExecutionIds).toEqual([]);
        await expect(rpc(identity, frame, original.signal)).resolves.toMatchObject({ ok: true });
        const physicalId = h.nativeExecutionIds[0];
        await expect(rpc(identity, frame, replacement.signal)).resolves.toMatchObject({
          ok: false,
          message: expect.stringContaining("start a new turn"),
        });
        expect(h.nativeExecutionIds).toEqual([physicalId]);
        await first.close("completion");
        expect(h.nativeExecutionIds).toEqual([physicalId, physicalId]);

        const nextClaim =
          renewal === "new claim" ? { ...h.claim, claimId: "claim-2", runId: "run-2" } : h.claim;
        if (h.state.placement.state !== "active") {
          throw new Error("Expected active placement");
        }
        h.state.placement = {
          ...h.state.placement,
          turnClaim: {
            owner: "worker",
            claimId: nextClaim.claimId,
            runId: nextClaim.runId,
            generation: nextClaim.placementGeneration,
            ownerEpoch: 7,
          },
        };
        const nextRun = createOperationalRunInstanceRef(nextClaim.runId);
        claimAgentRunDelegatedAuthority(nextRun);
        const next = await service.prepare(nextClaim);
        if (!next) {
          throw new Error("Expected replacement session computer");
        }
        next.bind(nextRun);
        const nextIdentity = { ...identity, turnClaim: nextClaim, runId: nextClaim.runId };
        await expect(rpc(nextIdentity, frame, replacement.signal)).resolves.toMatchObject({
          ok: true,
        });
        const nextPhysicalId = h.nativeExecutionIds.at(-1);
        expect(nextPhysicalId).not.toBe(physicalId);
        original.abort();
        await expect(retained.invoke(request("type"))).rejects.toThrow(/closed|replaced/);
        await expect(rpc(identity, frame, original.signal)).resolves.toMatchObject({ ok: false });
        await expect(rpc(nextIdentity, frame, replacement.signal)).resolves.toMatchObject({
          ok: true,
        });
        expect(h.nativeExecutionIds).toEqual([
          physicalId,
          physicalId,
          nextPhysicalId,
          nextPhysicalId,
        ]);
        await next.close("completion");
        expect(h.nativeExecutionIds.at(-1)).toBe(nextPhysicalId);
        expect(h.nativeExecutionIds).toHaveLength(5);
      } finally {
        await service.close();
      }
    },
  );
});
