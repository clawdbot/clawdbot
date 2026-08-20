// Covers agent event sequencing and run context cleanup.
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AgentEventPayload,
  captureAgentRunLifecycleGeneration,
  emitAgentAuditEvent,
  emitAgentEvent,
  emitAgentEventForOwner,
  emitAgentEventIfCurrent,
  getAgentEventLifecycleGeneration,
  onAgentAuditEvent,
  onAgentEvent,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  runOncePerAgentRun,
  withAgentRunLifecycleGeneration,
} from "./agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  listAgentRunsForSession,
  readAgentRunIndexVersion,
  registerAgentRunContext,
  releaseAgentRunContext,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";
import { emitAgentRunStatusEvent } from "./agent-run-status-events.js";
import { recordAgentRunOutputTokens } from "./agent-run-usage.js";

type AgentEventsModule = {
  events: typeof import("./agent-events.js");
  registry: typeof import("./agent-run-registry.js");
};

const agentEventsModuleUrl = new URL("./agent-events.ts", import.meta.url).href;
const agentRunRegistryModuleUrl = new URL("./agent-run-registry.ts", import.meta.url).href;

async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  const [events, registry] = await Promise.all([
    import(`${agentEventsModuleUrl}?t=${cacheBust}`),
    import(`${agentRunRegistryModuleUrl}?t=${cacheBust}`),
  ]);
  return { events, registry } as AgentEventsModule;
}

describe("agent-events sequencing", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("emits typed run startup status with run context", () => {
    registerAgentRunContext("run-status", { sessionKey: "session-status", agentId: "main" });
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));

    emitAgentRunStatusEvent({ runId: "run-status", phase: "preparing_workspace" });

    expect(events).toEqual([
      expect.objectContaining({
        runId: "run-status",
        seq: 1,
        stream: "run_status",
        sessionKey: "session-status",
        agentId: "main",
        data: { phase: "preparing_workspace" },
      }),
    ]);
    unsubscribe();
  });

  test("stores and clears run context", () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("versions active-run projection ownership transitions", () => {
    let version = readAgentRunIndexVersion();
    registerAgentRunContext("projected-run", {
      projectSessionActive: true,
      sessionId: "projected-session-id",
      sessionKey: "agent:main:projected",
    });
    expect(readAgentRunIndexVersion()).toBeGreaterThan(version);
    version = readAgentRunIndexVersion();

    registerAgentRunContext("projected-run", { verboseLevel: "full" });
    expect(readAgentRunIndexVersion()).toBe(version);

    const claimId = claimAgentRunContext(
      "owned-projected-run",
      {
        projectSessionActive: true,
        sessionId: "owned-session-id",
        sessionKey: "agent:main:owned",
      },
      { ownsContext: true, trackOwner: true },
    );
    expect(readAgentRunIndexVersion()).toBeGreaterThan(version);
    version = readAgentRunIndexVersion();

    releaseAgentRunContext("owned-projected-run", claimId);
    expect(readAgentRunIndexVersion()).toBeGreaterThan(version);
    version = readAgentRunIndexVersion();

    clearAgentRunContext("projected-run");
    expect(readAgentRunIndexVersion()).toBeGreaterThan(version);
  });

  test("does not let an old execution clear a newer same-id context", () => {
    registerAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration: "post-restart",
    });

    clearAgentRunContext("shared-run", "pre-restart");
    expect(getAgentRunContext("shared-run")?.lifecycleGeneration).toBe("post-restart");

    clearAgentRunContext("shared-run", "post-restart");
    expect(getAgentRunContext("shared-run")).toBeUndefined();
  });

  test("accumulates output usage across attempts and resets with run context", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("usage-run", { sessionKey: "main", lifecycleGeneration });
    const seen: number[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "usage-run" && event.stream === "usage") {
        seen.push(event.data.outputTokens as number);
      }
    });
    const emitUsage = (outputTokens: number) => {
      recordAgentRunOutputTokens({
        runId: "usage-run",
        lifecycleGeneration,
        outputTokens,
        emit: (data) =>
          emitAgentEventIfCurrent({
            runId: "usage-run",
            lifecycleGeneration,
            stream: "usage",
            data,
          }),
      });
    };

    emitUsage(12);
    registerAgentRunContext("usage-run", { sessionKey: "main", lifecycleGeneration });
    emitUsage(8);
    clearAgentRunContext("usage-run", lifecycleGeneration);
    registerAgentRunContext("usage-run", { sessionKey: "main", lifecycleGeneration });
    emitUsage(3);
    stop();

    expect(seen).toEqual([12, 20, 3]);
  });

  test("clears sequence state when guarded cleanup finds no run context", () => {
    const seen: number[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "contextless-run") {
        seen.push(event.seq);
      }
    });

    emitAgentEvent({ runId: "contextless-run", stream: "assistant", data: { text: "first" } });
    clearAgentRunContext("contextless-run", getAgentEventLifecycleGeneration());
    emitAgentEvent({ runId: "contextless-run", stream: "assistant", data: { text: "second" } });
    stop();

    expect(seen).toEqual([1, 1]);
  });

  test("keeps audit-only events off the shared agent event bus", () => {
    const shared: AgentEventPayload[] = [];
    const audit: AgentEventPayload[] = [];
    const stopShared = onAgentEvent((event) => shared.push(event));
    const stopAudit = onAgentAuditEvent((event) => audit.push(event));

    emitAgentAuditEvent({
      runId: "audit-only-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentAuditEvent({
      runId: "audit-only-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    emitAgentAuditEvent({
      runId: "audit-only-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });

    stopShared();
    stopAudit();
    expect(shared).toEqual([]);
    expect(audit.map((event) => [event.data.phase, event.seq])).toEqual([
      ["start", 1],
      ["end", 2],
      ["start", 1],
    ]);
    expect(audit[0]).toMatchObject({
      runId: "audit-only-run",
      sessionKey: "agent:main:acp:session",
      stream: "lifecycle",
    });
  });

  test("preserves sequence state when same-generation ownership is reclaimed", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext("retry-run", {
      sessionKey: "main",
      lifecycleGeneration,
    });
    const seen: number[] = [];
    const stop = onAgentEvent((event) => {
      if (event.runId === "retry-run") {
        seen.push(event.seq);
      }
    });

    emitAgentEvent({ runId: "retry-run", stream: "assistant", data: { text: "first" } });
    claimAgentRunContext("retry-run", {
      sessionKey: "main",
      lifecycleGeneration,
    });
    emitAgentEvent({ runId: "retry-run", stream: "assistant", data: { text: "second" } });
    stop();

    expect(seen).toEqual([1, 2]);
  });

  test("keeps a tracked context until every overlapping owner exits", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const firstOwner = claimAgentRunContext(
      "shared-run",
      { sessionKey: "main", lifecycleGeneration },
      { trackOwner: true },
    );
    const secondOwner = claimAgentRunContext(
      "shared-run",
      { sessionKey: "main", lifecycleGeneration },
      { trackOwner: true },
    );

    clearAgentRunContext("shared-run", lifecycleGeneration);
    releaseAgentRunContext("shared-run", firstOwner);
    expect(getAgentRunContext("shared-run")).toBeDefined();

    releaseAgentRunContext("shared-run", secondOwner);
    expect(getAgentRunContext("shared-run")).toBeUndefined();
  });

  test("clears tracked context after an inner same-generation reclaim", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const ownerToken = claimAgentRunContext(
      "shared-run",
      { sessionKey: "main", lifecycleGeneration },
      { trackOwner: true },
    );

    claimAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration,
      verboseLevel: "off",
    });
    releaseAgentRunContext("shared-run", ownerToken);

    expect(getAgentRunContext("shared-run")).toBeUndefined();
  });

  test("honors a matching clear deferred behind a tracked owner", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration,
    });
    const ownerToken = claimAgentRunContext(
      "shared-run",
      { sessionKey: "main", lifecycleGeneration },
      { trackOwner: true },
    );

    clearAgentRunContext("shared-run", lifecycleGeneration);
    releaseAgentRunContext("shared-run", ownerToken);

    expect(getAgentRunContext("shared-run")).toBeUndefined();
  });

  test("reserves exclusive run ids for owner-only delivery and cleanup", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claimId = claimAgentRunContext(
      "exclusive-run",
      { sessionKey: "worker" },
      { exclusive: true, trackOwner: true },
    )!;
    expect(
      claimAgentRunContext("exclusive-run", { sessionKey: "local" }, { trackOwner: true }),
    ).toBeUndefined();
    const seen: unknown[] = [];
    const stop = onAgentEvent(({ data }) => seen.push(data.text));
    const event = (text: string) => ({
      runId: "exclusive-run",
      stream: "assistant" as const,
      data: { text },
    });

    emitAgentEvent(event("local"));
    emitAgentEventForOwner(event("worker"), claimId);

    clearAgentRunContext("exclusive-run", lifecycleGeneration);

    expect(getAgentRunContext("exclusive-run")?.sessionKey).toBe("worker");
    releaseAgentRunContext("exclusive-run", claimId);
    expect(getAgentRunContext("exclusive-run")).toBeUndefined();
    emitAgentEventForOwner(event("late"), claimId);
    stop();
    expect(seen).toEqual(["worker"]);
  });

  test("explicitly adopts only an unowned same-generation context", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("adopted-run", {
      agentId: "main",
      isControlUiVisible: false,
      lifecycleGeneration,
      sessionId: "session-adopted",
      sessionKey: "agent:main:adopted",
    });

    const claimId = claimAgentRunContext(
      "adopted-run",
      {
        agentId: "main",
        isControlUiVisible: false,
        lifecycleGeneration,
        sessionId: "session-adopted",
        sessionKey: "agent:main:adopted",
      },
      {
        adoptExistingUnowned: true,
        exclusive: true,
        ownsContext: true,
        trackOwner: true,
      },
    );
    expect(claimId).toBeDefined();
    expect(
      claimAgentRunContext(
        "adopted-run",
        { lifecycleGeneration, sessionKey: "agent:main:adopted" },
        { adoptExistingUnowned: true, exclusive: true, trackOwner: true },
      ),
    ).toBeUndefined();

    releaseAgentRunContext("adopted-run", claimId);
    expect(getAgentRunContext("adopted-run")).toBeUndefined();
  });

  test("full event reset clears tracked ownership", () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(
      "shared-run",
      { sessionKey: "main", lifecycleGeneration },
      { trackOwner: true },
    );

    resetAgentEventsForTest();
    registerAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration,
    });
    clearAgentRunContext("shared-run", lifecycleGeneration);

    expect(getAgentRunContext("shared-run")).toBeUndefined();
  });

  test("drops stale explicit-generation events before shared listeners", () => {
    const activeGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration: activeGeneration,
    });
    const seen: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => seen.push(event));

    expect(
      emitAgentEventIfCurrent({
        runId: "shared-run",
        lifecycleGeneration: "pre-restart",
        stream: "lifecycle",
        data: { phase: "end" },
      }),
    ).toBe(false);
    expect(
      emitAgentEventIfCurrent({
        runId: "shared-run",
        lifecycleGeneration: activeGeneration,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      }),
    ).toBe(true);
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.seq).toBe(1);
    expect(seen[0]?.data.phase).toBe("start");
  });

  test("drops stale inherited-generation events from every stream", () => {
    const preRestartGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration: preRestartGeneration,
    });
    const seen: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => seen.push(event));

    rotateAgentEventLifecycleGeneration();
    const postRestartGeneration = getAgentEventLifecycleGeneration();
    withAgentRunLifecycleGeneration(preRestartGeneration, () => {
      emitAgentEvent({
        runId: "shared-run",
        stream: "assistant",
        data: { text: "stale" },
      });
    });
    claimAgentRunContext("shared-run", {
      sessionKey: "main",
      lifecycleGeneration: postRestartGeneration,
    });
    withAgentRunLifecycleGeneration(postRestartGeneration, () => {
      emitAgentEvent({
        runId: "shared-run",
        stream: "tool",
        data: { name: "current" },
      });
    });
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.seq).toBe(1);
    expect(seen[0]?.stream).toBe("tool");
  });

  test("captures inherited lifecycle ownership for descendant runs", () => {
    const preRestartGeneration = getAgentEventLifecycleGeneration();
    rotateAgentEventLifecycleGeneration();

    const captured = withAgentRunLifecycleGeneration(preRestartGeneration, () =>
      captureAgentRunLifecycleGeneration("descendant-run"),
    );

    expect(captured).toBe(preRestartGeneration);
  });

  test("shares one run operation across nested fallback scopes", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const operation = vi.fn(async () => "claimed");

    const results = await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => [
      await runOncePerAgentRun("run-1", "before_agent_reply", operation),
      await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
        runOncePerAgentRun("run-1", "before_agent_reply", operation),
      ),
    ]);

    expect(results).toEqual(["claimed", "claimed"]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("does not share run operations across admitted execution scopes", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const operation = vi.fn(async () => "declined");

    await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
      runOncePerAgentRun("run-1", "before_agent_reply", operation),
    );
    await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
      runOncePerAgentRun("run-1", "before_agent_reply", operation),
    );

    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("lists only runs owned by the current lifecycle", () => {
    const preRestartGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext("stale-run", {
      sessionKey: "main",
      lifecycleGeneration: preRestartGeneration,
    });
    const currentLifecycleGeneration = rotateAgentEventLifecycleGeneration();
    claimAgentRunContext("current-run", {
      sessionKey: "main",
      lifecycleGeneration: currentLifecycleGeneration,
    });

    expect(listAgentRunsForSession({ sessionKey: "main" })).toEqual([
      {
        runId: "current-run",
        lifecycleGeneration: currentLifecycleGeneration,
      },
    ]);
  });

  test("drops stale-generation terminal lifecycle after rotation", () => {
    const preRestartGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext("interrupted-run", {
      sessionKey: "main",
      lifecycleGeneration: preRestartGeneration,
    });
    rotateAgentEventLifecycleGeneration();
    const seen: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => seen.push(event));

    withAgentRunLifecycleGeneration(preRestartGeneration, () => {
      emitAgentEvent({
        runId: "interrupted-run",
        stream: "lifecycle",
        data: { phase: "end" },
      });
    });
    stop();

    expect(seen).toHaveLength(0);
  });

  test("stamps the owning sessionId onto lifecycle events for reset-stale guarding (#88538)", () => {
    registerAgentRunContext("run-1", { sessionKey: "main", sessionId: "old-session-id" });
    const seen: Array<{ stream: string; sessionId?: string }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-1") {
        seen.push({ stream: evt.stream, sessionId: evt.sessionId });
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "error" } });
    emitAgentEvent({ runId: "run-1", stream: "item", data: {} });

    stop();

    expect(seen.find((evt) => evt.stream === "lifecycle")?.sessionId).toBe("old-session-id");
    // Only lifecycle events carry the sessionId; other streams stay unstamped.
    expect(seen.find((evt) => evt.stream === "item")?.sessionId).toBeUndefined();
  });

  test("rejects lifecycle starts without a finite producer timestamp", () => {
    const seen: unknown[] = [];
    const stop = onAgentEvent((evt) => seen.push(evt));

    emitAgentEvent({ runId: "missing", stream: "lifecycle", data: { phase: "start" } });
    emitAgentEvent({
      runId: "invalid",
      stream: "lifecycle",
      data: { phase: "start", startedAt: Number.NaN },
    });
    emitAgentEvent({
      runId: "valid",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_234 },
    });
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: "valid",
      data: { phase: "start", startedAt: 1_234 },
    });
  });

  test.each(["end", "error"] as const)(
    "stamps the owning start onto an older overlapping run's %s event",
    (phase) => {
      registerAgentRunContext("older-run", { sessionKey: "shared-session" });
      registerAgentRunContext("newer-run", { sessionKey: "shared-session" });
      const seen: AgentEventPayload[] = [];
      const stop = onAgentEvent((event) => seen.push(event));

      emitAgentEvent({
        runId: "older-run",
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      emitAgentEvent({
        runId: "newer-run",
        stream: "lifecycle",
        data: { phase: "start", startedAt: 2_000 },
      });
      emitAgentEvent({
        runId: "older-run",
        stream: "lifecycle",
        data: { phase, endedAt: 3_000 },
      });
      emitAgentEvent({
        runId: "newer-run",
        stream: "lifecycle",
        data: { phase: "end", endedAt: 4_000 },
      });
      stop();

      expect(seen.map((event) => [event.runId, event.data.phase, event.data.startedAt])).toEqual([
        ["older-run", "start", 1_000],
        ["newer-run", "start", 2_000],
        ["older-run", phase, 1_000],
        ["newer-run", "end", 2_000],
      ]);
    },
  );

  test("does not invent or replace producer-owned lifecycle start timestamps", () => {
    registerAgentRunContext("unstarted-run", { sessionKey: "shared-session" });
    registerAgentRunContext("started-run", { sessionKey: "shared-session" });
    const seen: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => seen.push(event));

    emitAgentEvent({ runId: "unstarted-run", stream: "lifecycle", data: { phase: "end" } });
    emitAgentEvent({
      runId: "started-run",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    emitAgentEvent({
      runId: "started-run",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 1_500 },
    });
    stop();

    expect(seen[0]?.data).toEqual({ phase: "end" });
    expect(seen[2]?.data.startedAt).toBe(1_500);
  });

  test("rejects old runs after restart and stamps the new generation", () => {
    const oldGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("old-run", { sessionKey: "main" });
    const newGeneration = rotateAgentEventLifecycleGeneration();
    registerAgentRunContext("new-run", { sessionKey: "main" });
    const seen = new Map<string, { generation?: string; keys: string[] }>();
    const stop = onAgentEvent((evt) => {
      if (evt.stream === "lifecycle") {
        seen.set(evt.runId, {
          generation: evt.lifecycleGeneration,
          keys: Object.keys(evt),
        });
      }
    });

    emitAgentEvent({ runId: "old-run", stream: "lifecycle", data: { phase: "end" } });
    emitAgentEvent({
      runId: "new-run",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_234 },
    });
    stop();

    expect(newGeneration).not.toBe(oldGeneration);
    expect(seen.has("old-run")).toBe(false);
    expect(seen.get("new-run")?.generation).toBe(newGeneration);
    expect(seen.get("new-run")?.keys).not.toContain("lifecycleGeneration");
  });

  test("stamps session lifecycle projection policy without serializing it", () => {
    registerAgentRunContext("maintenance-run", {
      projectSessionLifecycle: false,
      sessionKey: "main",
    });
    let received:
      | {
          projectSessionLifecycle?: boolean;
          keys: string[];
        }
      | undefined;
    const stop = onAgentRuntimeEvent((evt) => {
      received = {
        projectSessionLifecycle: evt.projectSessionLifecycle,
        keys: Object.keys(evt),
      };
    });

    emitAgentEvent({
      runId: "maintenance-run",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_234 },
    });
    stop();

    expect(received?.projectSessionLifecycle).toBe(false);
    expect(received?.keys).not.toContain("projectSessionLifecycle");
  });

  test("lets a newly admitted retry claim an explicit lifecycle generation", () => {
    registerAgentRunContext("shared-run-id", { sessionKey: "main" });
    const oldGeneration = getAgentRunContext("shared-run-id")?.lifecycleGeneration;
    const newGeneration = rotateAgentEventLifecycleGeneration();

    claimAgentRunContext("shared-run-id", {
      sessionKey: "main",
      lifecycleGeneration: newGeneration,
    });

    expect(newGeneration).not.toBe(oldGeneration);
    expect(getAgentRunContext("shared-run-id")?.lifecycleGeneration).toBe(newGeneration);
  });

  test("does not let an older execution reclaim a newly admitted run id", () => {
    claimAgentRunContext("shared-run-id", {
      sessionKey: "new-session",
      lifecycleGeneration: "post-restart",
    });

    registerAgentRunContext("shared-run-id", {
      sessionKey: "old-session",
      lifecycleGeneration: "pre-restart",
      isControlUiVisible: false,
    });

    expect(getAgentRunContext("shared-run-id")).toEqual(
      expect.objectContaining({
        sessionKey: "new-session",
        lifecycleGeneration: "post-restart",
      }),
    );
    expect(getAgentRunContext("shared-run-id")?.isControlUiVisible).toBeUndefined();
  });

  test("refreshes the stamped sessionId when run context is re-registered (#88538)", () => {
    registerAgentRunContext("run-1", { sessionKey: "main", sessionId: "start-id" });
    // Callers that already persisted a rotation can re-register the new owner.
    registerAgentRunContext("run-1", { sessionId: "rotated-id" });
    let stamped: string | undefined;
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-1" && evt.stream === "lifecycle") {
        stamped = evt.sessionId;
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: { phase: "end" } });

    stop();
    // Terminal event carries the rotated id, so persistence won't treat the
    // run as stale against the row it rotated to.
    expect(stamped).toBe("rotated-id");
  });

  test("maintains monotonic seq per runId", () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("omits sessionKey for non-lifecycle runs hidden from Control UI", () => {
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-quietchat",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "session-quietchat",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });

  test("preserves sessionKey for lifecycle events hidden from Control UI", () => {
    registerAgentRunContext("run-hidden-lifecycle", {
      sessionKey: "session-quietchat",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden-lifecycle",
      stream: "lifecycle",
      data: { phase: "end" },
      sessionKey: "session-quietchat",
    });
    stop();

    expect(receivedSessionKey).toBe("session-quietchat");
  });

  test("falls back to registered sessionKey for hidden lifecycle events", () => {
    registerAgentRunContext("run-hidden-lifecycle-context", {
      sessionKey: "session-quietchat-context",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden-lifecycle-context",
      stream: "lifecycle",
      data: { phase: "error", error: "boom" },
    });
    stop();

    expect(receivedSessionKey).toBe("session-quietchat-context");
  });

  test("stamps the resolved agent owner for unscoped session keys", () => {
    registerAgentRunContext("run-unscoped", {
      sessionKey: "global",
      agentId: "support",
    });

    let received: AgentEventPayload | undefined;
    const stop = onAgentEvent((event) => {
      received = event;
    });
    emitAgentEvent({
      runId: "run-unscoped",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1_000 },
    });
    stop();

    expect(received).toMatchObject({ sessionKey: "global", agentId: "support" });
  });

  test("merges later run context updates into existing runs", () => {
    registerAgentRunContext("run-ctx", {
      sessionKey: "session-main",
      isControlUiVisible: true,
    });
    registerAgentRunContext("run-ctx", {
      verboseLevel: "full",
      isHeartbeat: true,
      lastActiveAt: 12_345,
    });

    const context = getAgentRunContext("run-ctx");
    expect(context?.sessionKey).toBe("session-main");
    expect(context?.verboseLevel).toBe("full");
    expect(context?.isHeartbeat).toBe(true);
    expect(context?.isControlUiVisible).toBe(true);
    expect(context?.lastActiveAt).toBe(12_345);
  });

  test("falls back to registered sessionKey when event sessionKey is blank", () => {
    registerAgentRunContext("run-ctx", { sessionKey: "session-main" });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-ctx",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "   ",
    });
    stop();

    expect(receivedSessionKey).toBe("session-main");
  });

  test("keeps notifying later listeners when one throws", () => {
    const seen: string[] = [];
    const stopBad = onAgentEvent(() => {
      throw new Error("boom");
    });
    const stopGood = onAgentEvent((evt) => {
      seen.push(evt.runId);
    });

    expect(
      emitAgentEvent({
        runId: "run-safe",
        stream: "assistant",
        data: { text: "hi" },
      }),
    ).toBeUndefined();

    stopGood();
    stopBad();

    expect(seen).toEqual(["run-safe"]);
  });

  test("shares run context, listeners, and sequence state across duplicate module instances", async () => {
    const first = await importAgentEventsModule(`first-${Date.now()}`);
    const second = await importAgentEventsModule(`second-${Date.now()}`);

    first.events.resetAgentEventsForTest();
    first.registry.registerAgentRunContext("run-dup", { sessionKey: "session-dup" });

    const seen: Array<{ seq: number; sessionKey?: string }> = [];
    const stop = first.events.onAgentEvent((evt) => {
      if (evt.runId === "run-dup") {
        seen.push({ seq: evt.seq, sessionKey: evt.sessionKey });
      }
    });

    second.events.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from second" },
      sessionKey: "   ",
    });
    first.events.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from first" },
      sessionKey: "   ",
    });

    stop();

    expect(second.registry.getAgentRunContext("run-dup")?.sessionKey).toBe("session-dup");
    expect(seen).toEqual([
      { seq: 1, sessionKey: "session-dup" },
      { seq: 2, sessionKey: "session-dup" },
    ]);

    first.events.resetAgentEventsForTest();
  });

  test("sweeps stale run contexts and clears their sequence state", () => {
    const stop = vi.spyOn(Date, "now");
    stop.mockReturnValue(100);
    registerAgentRunContext("run-stale", { sessionKey: "session-stale", registeredAt: 100 });
    registerAgentRunContext("run-active", { sessionKey: "session-active", registeredAt: 100 });

    stop.mockReturnValue(200);
    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "stale" } });

    stop.mockReturnValue(900);
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "active" } });

    stop.mockReturnValue(1_000);
    const versionBeforeSweep = readAgentRunIndexVersion();
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(readAgentRunIndexVersion()).toBeGreaterThan(versionBeforeSweep);
    expect(getAgentRunContext("run-stale")).toBeUndefined();
    expect(getAgentRunContext("run-active")?.sessionKey).toBe("session-active");

    const seen: Array<{ runId: string; seq: number }> = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId === "run-stale" || evt.runId === "run-active") {
        seen.push({ runId: evt.runId, seq: evt.seq });
      }
    });

    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "restarted" } });
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "continued" } });

    unsubscribe();
    stop.mockRestore();

    expect(seen).toEqual([
      { runId: "run-stale", seq: 1 },
      { runId: "run-active", seq: 2 },
    ]);
  });

  test("protects only active queue leases while stale tracked and abandoned owners expire", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("queued-run", { lifecycleGeneration, registeredAt: 100 });
    registerAgentRunContext("abandoned-run", { lifecycleGeneration, registeredAt: 100 });
    claimAgentRunContext(
      "tracked-worker-run",
      { lifecycleGeneration, registeredAt: 100 },
      { exclusive: true, ownsContext: true, trackOwner: true },
    );
    const versionBeforeLease = readAgentRunIndexVersion();

    const firstLease = retainQueuedAgentRunContext("queued-run", lifecycleGeneration);
    const secondLease = retainQueuedAgentRunContext("queued-run", lifecycleGeneration);
    expect(firstLease).toBeTypeOf("function");
    expect(secondLease).toBeTypeOf("function");
    expect(retainQueuedAgentRunContext("missing-run", lifecycleGeneration)).toBeUndefined();
    expect(retainQueuedAgentRunContext("queued-run", "stale-generation")).toBeUndefined();
    expect(readAgentRunIndexVersion()).toBe(versionBeforeLease);

    clock.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(2);
    expect(readAgentRunIndexVersion()).toBeGreaterThan(versionBeforeLease);
    expect(getAgentRunContext("queued-run")).toBeDefined();
    expect(getAgentRunContext("abandoned-run")).toBeUndefined();
    expect(getAgentRunContext("tracked-worker-run")).toBeUndefined();

    const versionAfterSweep = readAgentRunIndexVersion();
    firstLease?.("admitted");
    firstLease?.("abandoned");
    expect(getAgentRunContext("queued-run")?.lastActiveAt).toBe(1_000);
    expect(readAgentRunIndexVersion()).toBe(versionAfterSweep);

    clock.mockReturnValue(1_501);
    expect(sweepStaleRunContexts(500)).toBe(0);
    expect(readAgentRunIndexVersion()).toBe(versionAfterSweep);
    secondLease?.("abandoned");
    expect(readAgentRunIndexVersion()).toBe(versionAfterSweep);
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(readAgentRunIndexVersion()).toBeGreaterThan(versionAfterSweep);
    expect(getAgentRunContext("queued-run")).toBeUndefined();
    clock.mockRestore();
  });

  test("never protects a retired lifecycle or refreshes a recycled run context", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const originalGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("recycled-run", {
      lifecycleGeneration: originalGeneration,
      registeredAt: 100,
    });
    const releaseOriginalLease = retainQueuedAgentRunContext("recycled-run", originalGeneration);

    clock.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(0);

    const replacementGeneration = rotateAgentEventLifecycleGeneration();
    expect(sweepStaleRunContexts(500)).toBe(1);
    claimAgentRunContext("recycled-run", {
      lifecycleGeneration: replacementGeneration,
      registeredAt: 100,
    });

    releaseOriginalLease?.("admitted");
    expect(getAgentRunContext("recycled-run")).toMatchObject({
      lifecycleGeneration: replacementGeneration,
      registeredAt: 100,
    });
    expect(getAgentRunContext("recycled-run")?.lastActiveAt).toBeUndefined();
    expect(sweepStaleRunContexts(500)).toBe(1);
    clock.mockRestore();
  });

  test("shares queue leases across duplicate modules without leaking through test resets", async () => {
    const first = await importAgentEventsModule(`queued-first-${Date.now()}`);
    const second = await importAgentEventsModule(`queued-second-${Date.now()}`);
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const lifecycleGeneration = first.events.getAgentEventLifecycleGeneration();
    first.registry.registerAgentRunContext("duplicate-module-run", {
      lifecycleGeneration,
      registeredAt: 100,
    });
    const releaseOriginalLease = second.registry.retainQueuedAgentRunContext(
      "duplicate-module-run",
      lifecycleGeneration,
    );

    clock.mockReturnValue(1_000);
    expect(first.registry.sweepStaleRunContexts(500)).toBe(0);

    first.events.resetAgentEventsForTest();
    first.registry.registerAgentRunContext("duplicate-module-run", {
      lifecycleGeneration,
      registeredAt: 100,
    });
    releaseOriginalLease?.("admitted");

    expect(first.registry.getAgentRunContext("duplicate-module-run")?.lastActiveAt).toBeUndefined();
    expect(first.registry.sweepStaleRunContexts(500)).toBe(1);
    first.events.resetAgentEventsForTest();
    clock.mockRestore();
  });
});

test("clearAgentRunContext also cleans up seqByRun to prevent memory leak (#63643)", () => {
  // Regression test: seqByRun entries were never deleted when a run ended,
  // causing unbounded growth over time.
  registerAgentRunContext("run-leak", { sessionKey: "main" });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });

  // After clearing run context, the sequence counter should also be removed.
  clearAgentRunContext("run-leak");

  // Emitting a new event on the same runId should start seq from 1 again,
  // proving the old entry was deleted.
  const seqs: number[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.runId === "run-leak") {
      seqs.push(evt.seq);
    }
  });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  stop();

  expect(seqs).toEqual([1]);
});
