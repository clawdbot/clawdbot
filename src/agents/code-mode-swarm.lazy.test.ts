import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PendingBridgeRequest } from "./code-mode-worker-types.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

it("fences swarm effects after owner or policy loss during a shared runtime import", async () => {
  vi.resetModules();
  const entered = createDeferred();
  const release = createDeferred();
  const bridgeCalls: Promise<void>[] = [];
  const cleanups: Array<() => void> = [];
  const lookup =
    vi.fn<
      typeof import("./subagents/registry/subagent-registry.js").getSwarmRunByLaunchReplayKey
    >();
  const initialize = vi.fn();
  const readCollectors =
    vi.fn<typeof import("./subagents/registry/subagent-registry.js").getSubagentRunsByRunIds>();
  const wait = vi.fn<typeof import("./tools/agents-wait-tool.js").waitForCollectorCompletion>();
  const subscribe =
    vi.fn<
      typeof import("./subagents/registry/subagent-registry-state.js").onSubagentRegistryPersisted
    >();
  const emit =
    vi.fn<typeof import("../sessions/session-lifecycle-events.js").emitSessionLifecycleEvent>();
  const load = vi.fn(
    async (importOriginal: () => Promise<typeof import("./code-mode-swarm.runtime.js")>) => {
      const actual = await importOriginal();
      entered.resolve();
      await release.promise;
      return actual;
    },
  );
  vi.doMock("./code-mode-swarm.runtime.js", load);
  vi.doMock("./subagents/registry/subagent-registry.js", () => ({
    getSwarmRunByLaunchReplayKey: lookup,
    initSubagentRegistry: initialize,
    getSubagentRunsByRunIds: readCollectors,
  }));
  vi.doMock("./tools/agents-wait-tool.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./tools/agents-wait-tool.js")>();
    wait.mockImplementation(actual.waitForCollectorCompletion);
    return { ...actual, waitForCollectorCompletion: wait };
  });
  vi.doMock("./subagents/registry/subagent-registry-state.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("./subagents/registry/subagent-registry-state.js")>();
    subscribe.mockImplementation(actual.onSubagentRegistryPersisted);
    return { ...actual, onSubagentRegistryPersisted: subscribe };
  });
  vi.doMock("../sessions/session-lifecycle-events.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../sessions/session-lifecycle-events.js")>();
    emit.mockImplementation(actual.emitSessionLifecycleEvent);
    return { ...actual, emitSessionLifecycleEvent: emit };
  });
  try {
    const { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } =
      await import("./code-mode.js");
    const { clearToolSearchCatalog, createToolSearchCatalogRef } =
      await import("./tool-search-catalog.js");
    const { ToolSearchRuntime } = await import("./tool-search-runtime.js");
    const { toToolSearchConfig } = await import("./code-mode-runtime.js");
    const { createCodeModeCatalogProjection } = await import("./code-mode-catalog.js");
    const { createCodeModeNamespaceRuntime } = await import("./code-mode-namespaces.js");
    const bridge = await import("./code-mode-bridge.js");
    const originalBridge = bridge.runBridgeRequest;
    vi.spyOn(bridge, "runBridgeRequest").mockImplementation((params) => {
      const call = originalBridge(params);
      bridgeCalls.push(call);
      return call;
    });
    const { createCodeModeRunOwner, createPendingBridgeStates, createCodeModeBridgeDispatchState } =
      await import("./code-mode-state.js");
    const spawn = vi.fn(async () => ({
      content: [],
      details: { status: "accepted", runId: "collector" },
    }));
    const requests: PendingBridgeRequest[] = [
      { id: "spawn", method: "agentSpawn", args: ["Research"] },
      { id: "wait", method: "agentWait", args: ["collector"] },
      { id: "note", method: "swarmNote", args: [{ kind: "phase", text: "Plan" }] },
    ];
    const reservation: SubagentRunRecord = {
      runId: "collector",
      childSessionKey: "agent:main:subagent:collector",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      swarmRequesterSessionKey: "agent:main:main",
      task: "Research",
      collect: true,
      cleanup: "delete",
      createdAt: 1,
      execution: { status: "running" },
      swarmLaunchReplayKey: "replay:spawn",
      swarmLaunchPending: true,
      swarmLaunchRequestFingerprint: `sha256:${createHash("sha256")
        .update(
          stableStringify({
            task: "Research",
            collect: true,
            groupId: "swarm:agent:main:main:run-swarm",
          }),
        )
        .digest("hex")}`,
      queuedLaunch: { request: {}, timeoutMs: 1, schedulerGroupKey: "group", maxConcurrent: 1 },
    };
    lookup.mockReturnValue(reservation);
    readCollectors.mockReturnValue({
      entries: new Map([
        [
          "collector",
          {
            ...reservation,
            collectorCompletion: { status: "done", structured: { answer: 42 } },
          },
        ],
      ]),
    });

    function createRun() {
      const catalogRef = createToolSearchCatalogRef();
      const config = { tools: { codeMode: true, swarm: { enabled: true } } };
      const ctx: ToolSearchToolContext = {
        config,
        runtimeConfig: config,
        catalogRef,
        sessionKey: "agent:main:main",
        sessionId: "session-swarm",
        runId: "run-swarm",
      };
      const spawnTool: AnyAgentTool = {
        name: "sessions_spawn",
        label: "Spawn",
        description: "Spawn a collector",
        parameters: { type: "object", properties: {} },
        execute: spawn,
      };
      applyCodeModeCatalog({ ...ctx, tools: [...createCodeModeTools(ctx), spawnTool] });
      const owner = createCodeModeRunOwner(ctx, resolveCodeModeConfig(config));
      cleanups.push(() => {
        owner.close();
        clearToolSearchCatalog(ctx);
      });
      const limits = resolveCodeModeConfig(config);
      const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(limits));
      return {
        ctx,
        config,
        owner,
        dispatch: (pendingRequests = requests) =>
          createPendingBridgeStates(pendingRequests, {
            config: limits,
            inbox: owner.inbox,
            runtime,
            ctx,
            catalogProjection: createCodeModeCatalogProjection(runtime.all({ includeMcp: false })),
            namespaceRuntime: createCodeModeNamespaceRuntime(runtime.namespaceEntries()),
            parentToolCallId: "swarm-call",
            codeModeRunId: "replay",
            remainingMs: 10_000,
            signal: owner.signal,
            bridgeDispatch: createCodeModeBridgeDispatchState(),
          }),
      };
    }

    // Cheap refusals must not start the shared load at all.
    for (const gate of ["disabled", "allowlist"] as const) {
      const run = createRun();
      if (gate === "disabled") {
        run.config.tools.swarm.enabled = false;
      } else {
        run.ctx.toolExecutionAllow = ["skill_workshop"];
      }
      const pending = run.dispatch();
      await Promise.all(pending.map((entry) => entry.promise));
      expect(pending.every((entry) => !entry.reply.take().ok)).toBe(true);
      expect(load).not.toHaveBeenCalled();
    }

    const closedRuns = ["owner", "catalog", "disabled", "allowlist"].map((kind) => {
      const run = createRun();
      return { kind, run, pending: run.dispatch() };
    });
    const survivor = createRun();
    const live = survivor.dispatch([
      { id: "live-note", method: "swarmNote", args: [{ kind: "log", text: "Still live" }] },
    ]);
    await entered.promise;
    for (const { kind, run, pending } of closedRuns) {
      if (kind === "owner") {
        run.owner.close(new Error("owner closed"));
      } else if (kind === "catalog") {
        clearToolSearchCatalog(run.ctx);
      } else if (kind === "disabled") {
        run.config.tools.swarm.enabled = false;
      } else {
        run.ctx.toolExecutionAllow = ["skill_workshop"];
      }
      if (kind === "owner" || kind === "catalog") {
        expect(run.owner.signal.aborted).toBe(true);
        for (const entry of pending) {
          expect(await entry.promise).toBeUndefined();
          expect(() => entry.reply.take()).toThrow("unavailable");
        }
      }
    }
    release.resolve();
    // The cancellation race settles first; join the original work before checking effects.
    for (const { kind, pending } of closedRuns) {
      for (const entry of pending) {
        await entry.promise;
        if (kind === "owner" || kind === "catalog") {
          expect(() => entry.reply.take()).toThrow("unavailable");
        } else {
          expect(entry.reply.take().ok).toBe(false);
        }
      }
    }
    await Promise.all(live.map((entry) => entry.promise));
    expect(live.map((entry) => entry.reply.take())).toEqual([
      { id: "live-note", ok: true, json: JSON.stringify({ ok: true }) },
    ]);
    const originals = await Promise.all(bridgeCalls);
    expect(originals).toHaveLength(requests.length * (2 + closedRuns.length) + live.length);
    expect(originals.every((entry) => entry === undefined)).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(readCollectors).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-swarm",
      kind: "log",
      text: "Still live",
    });
  } finally {
    cleanups.forEach((cleanup) => cleanup());
    release.resolve();
    await Promise.allSettled(bridgeCalls);
    vi.restoreAllMocks();
    vi.doUnmock("./code-mode-swarm.runtime.js");
    vi.doUnmock("./subagents/registry/subagent-registry.js");
    vi.doUnmock("./subagents/registry/subagent-registry-state.js");
    vi.doUnmock("./tools/agents-wait-tool.js");
    vi.doUnmock("../sessions/session-lifecycle-events.js");
    vi.resetModules();
  }
});
