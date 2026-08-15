import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";

const records = new Map<string, SubagentRunRecord>();
const registryEvents = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  getSubagentRunsByRunIds: (runIds: readonly string[]) => ({
    entries: new Map(
      runIds.flatMap((runId) => {
        const entry =
          records.get(runId) ??
          [...records.values()].find((candidate) => candidate.swarmRunId === runId);
        return entry ? [[runId, entry] as const] : [];
      }),
    ),
    latestByChildSessionKey: new Map(
      [...records.values()].map((entry) => [entry.childSessionKey, entry]),
    ),
  }),
}));

vi.mock("../subagents/registry/subagent-registry-state.js", () => ({
  onSubagentRegistryPersisted: (listener: () => void) => {
    registryEvents.listeners.add(listener);
    return () => registryEvents.listeners.delete(listener);
  },
}));

import { isToolResultError } from "../tool-result-error.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";

function collectorRun(
  runId: string,
  requesterSessionKey: string,
  completion?: SubagentRunRecord["collectorCompletion"],
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: completion ? "terminal" : "running" },
    collect: true,
    swarmRequesterSessionKey: requesterSessionKey,
    groupId: "group",
    completion: { required: false, resultText: completion ? `result-${runId}` : undefined },
    collectorCompletion: completion,
  };
}

describe("agents_wait", () => {
  beforeEach(() => {
    records.clear();
    registryEvents.listeners.clear();
  });

  it("settles a parked collector bridge from a registry write event", async () => {
    const entry = collectorRun("event-driven", "agent:main:main");
    records.set(entry.runId, entry);
    const completion = waitForCollectorCompletion({
      runId: entry.runId,
      currentSessionKeys: new Set(["agent:main:main"]),
    });

    entry.completion = { required: false, resultText: "event result" };
    entry.collectorCompletion = { status: "done" };
    for (const listener of registryEvents.listeners) {
      listener();
    }

    await expect(completion).resolves.toMatchObject({
      runId: "event-driven",
      status: "done",
      result: "event result",
    });
    expect(registryEvents.listeners.size).toBe(0);
  });

  it("returns retained visible output when a successful collector ends with NO_REPLY", async () => {
    const entry = collectorRun("retained", "agent:main:main", { status: "done" });
    entry.execution = { status: "terminal", outcome: { status: "ok" } };
    entry.completion = {
      required: false,
      resultText: "NO_REPLY",
      fallbackResultText: "retained collector result",
    };
    records.set(entry.runId, entry);

    await expect(
      waitForCollectorCompletion({
        runId: entry.runId,
        currentSessionKeys: new Set(["agent:main:main"]),
      }),
    ).resolves.toMatchObject({ result: "retained collector result" });
  });

  it("rejects when abort wins the listener-registration race", async () => {
    const entry = collectorRun("abort-race", "agent:main:main");
    records.set(entry.runId, entry);
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      controller.abort();
      originalAddEventListener(...args);
    });

    await expect(
      waitForCollectorCompletion({
        runId: entry.runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        signal: controller.signal,
      }),
    ).rejects.toThrow("agents.run wait aborted");
    expect(registryEvents.listeners.size).toBe(0);
  });

  it("returns the first completed child and leaves siblings pending", async () => {
    records.set("one", collectorRun("one", "agent:main:main"));
    records.set("two", collectorRun("two", "agent:main:main"));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    setTimeout(() => {
      const entry = records.get("two");
      if (!entry) {
        return;
      }
      entry.completion = { required: false, resultText: "result-two" };
      entry.collectorCompletion = {
        status: "done",
        structured: { winner: 2 },
      };
    }, 5);

    const result = await tool.execute("call", { ids: ["one", "two"], timeoutSeconds: 1 });
    expect(result.details).toEqual({
      completed: [
        {
          runId: "two",
          status: "done",
          result: "result-two",
          structured: { winner: 2 },
          sessionKey: "agent:worker:subagent:two",
        },
      ],
      pending: ["one"],
    });
  });

  it("projects an authorized collector failure without failing a mixed batch", async () => {
    const failed = collectorRun("failed", "agent:main:main", {
      status: "failed",
      structured: { partial: true },
    });
    failed.execution = {
      status: "terminal",
      outcome: { status: "error", error: "provider failed after tool output" },
    };
    failed.completion = { required: false, resultText: null, capturedAt: 10 };
    records.set(failed.runId, failed);
    records.set("pending", collectorRun("pending", "agent:main:main"));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", {
      ids: [failed.runId, "pending"],
      timeoutSeconds: 0,
    });

    expect(result.details).toEqual({
      completed: [
        {
          runId: failed.runId,
          status: "failed",
          result: "",
          structured: { partial: true },
          error: "provider failed after tool output",
          sessionKey: failed.childSessionKey,
        },
      ],
      pending: ["pending"],
    });
    expect(isToolResultError(result)).toBe(false);
  });

  it("orders completions by their durable capture time instead of input order", async () => {
    const later = collectorRun("later", "agent:main:main", { status: "done" });
    later.completion = { required: false, resultText: "later", capturedAt: 10 };
    const earlier = collectorRun("earlier", "agent:main:main", { status: "done" });
    earlier.completion = { required: false, resultText: "earlier", capturedAt: 5 };
    records.set(later.runId, later);
    records.set(earlier.runId, earlier);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", {
      ids: ["later", "earlier"],
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      completed: [{ runId: "earlier" }, { runId: "later" }],
      pending: [],
    });
  });

  it("is idempotent and returns per-id ownership and unknown errors", async () => {
    const done = collectorRun("done", "agent:worker:subagent:owner", { status: "done" });
    done.swarmWaitOwnerSessionKeys = ["agent:worker:subagent:owner", "agent:main:main"];
    records.set("done", done);
    records.set("owner", collectorRun("owner", "agent:main:main"));
    records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "failed" }));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: { enabled: true, waitTimeoutSecondsMax: 1 } } },
    });

    const first = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    const second = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    expect(second.details).toEqual(first.details);
    expect(first.details).toMatchObject({
      completed: [{ runId: "done", status: "done" }],
      pending: [],
      errors: [
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ],
    });
    expect(isToolResultError(first)).toBe(false);
  });

  it("authorizes a snapshotted ancestor after the ordinary spawner row is archived", async () => {
    const ownerSessionKey = "agent:worker:subagent:ordinary-owner";
    records.set("ordinary-owner", {
      runId: "ordinary-owner",
      childSessionKey: ownerSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "spawn collector",
      cleanup: "delete",
      createdAt: Date.now(),
      execution: { status: "running" },
    });
    const completed = collectorRun("nested", ownerSessionKey, { status: "done" });
    completed.swarmWaitOwnerSessionKeys = [ownerSessionKey, "agent:main:main"];
    records.set(completed.runId, completed);
    records.delete("ordinary-owner");
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["nested"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "nested", status: "done" }],
      pending: [],
    });
  });

  it("keeps the public collector id after gateway run replacement", async () => {
    const remapped = collectorRun("gateway-run", "agent:main:main", { status: "done" });
    remapped.swarmRunId = "collector-run";
    records.set(remapped.runId, remapped);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it("re-resolves a collector replaced while waiting", async () => {
    const pending = collectorRun("old-gateway-run", "agent:main:main");
    pending.swarmRunId = "collector-run";
    records.set(pending.runId, pending);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    setTimeout(() => {
      records.delete(pending.runId);
      const completed = collectorRun("new-gateway-run", "agent:main:main", { status: "done" });
      completed.swarmRunId = "collector-run";
      records.set(completed.runId, completed);
    }, 5);

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 1 });
    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it("does not treat a routed completion owner as the spawning session", async () => {
    const routed = collectorRun("routed", "agent:main:main", { status: "done" });
    routed.controllerSessionKey = "agent:worker:route-a";
    routed.swarmRequesterSessionKey = "agent:worker:route-a";
    records.set(routed.runId, routed);
    const routedOwner = createAgentsWaitTool({
      agentSessionKey: "agent:worker:route-a",
      agentId: "worker",
      config: { tools: { swarm: true } },
    });
    const completionOwner = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const allowed = await routedOwner.execute("owner", { ids: ["routed"], timeoutSeconds: 0 });
    const denied = await completionOwner.execute("proxy", {
      ids: ["routed"],
      timeoutSeconds: 0,
    });

    expect(allowed.details).toMatchObject({ completed: [{ runId: "routed" }] });
    expect(denied.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "routed", error: "not_owner" }],
      success: false,
    });
    expect(isToolResultError(denied)).toBe(true);
  });

  it("rejects a foreign collector with the same bare requester key", async () => {
    const foreign = collectorRun("foreign-global", "global", { status: "done" });
    foreign.requesterAgentId = "ops";
    records.set(foreign.runId, foreign);
    const tool = createAgentsWaitTool({
      agentSessionKey: "global",
      agentId: "research",
      config: {
        agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
        tools: { swarm: true },
      },
    });

    const result = await tool.execute("wait", {
      ids: [foreign.runId],
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      errors: [{ runId: foreign.runId, error: "not_owner" }],
      success: false,
    });
  });

  it("marks entirely missing collector batches as failures without losing per-id errors", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["missing"], timeoutSeconds: 0 });

    expect(result.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "missing", error: "not_found" }],
      success: false,
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("rejects collector batches containing only blank run ids", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    await expect(tool.execute("call", { ids: [" ", "\t"], timeoutSeconds: 0 })).rejects.toThrow(
      "at least one non-empty run id",
    );
  });

  it.each(["before", "during", "registration"] as const)(
    "rejects when the wait is aborted %s collector polling",
    async (abortTiming) => {
      records.set("pending", collectorRun("pending", "agent:main:main"));
      const tool = createAgentsWaitTool({
        agentSessionKey: "agent:main:main",
        agentId: "main",
        config: { tools: { swarm: true } },
      });
      const controller = new AbortController();
      if (abortTiming === "before") {
        controller.abort();
      }
      if (abortTiming === "registration") {
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
          controller.abort();
          addEventListener(...args);
        });
      }

      const result = tool.execute(
        "call",
        { ids: ["pending"], timeoutSeconds: 1 },
        controller.signal,
      );
      if (abortTiming === "during") {
        controller.abort();
      }

      await expect(result).rejects.toMatchObject({
        name: "AbortError",
        message: "agents_wait aborted.",
      });
    },
  );

  it("rejects oversized wait batches before polling", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    await expect(
      tool.execute("call", {
        ids: Array.from({ length: 1_001 }, (_, index) => `run-${index}`),
      }),
    ).rejects.toThrow("at most 1000 ids");
  });
});
