// Canonical Gateway active-work waiting must report the owners that block shutdown.
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { GatewaySuspendPrepareResultSchema } from "../../packages/gateway-protocol/src/index.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "./gateway-active-work.js";

const activeRuns = new Map<string, EmbeddedAgentQueueHandle>();

afterEach(() => {
  for (const [sessionId, handle] of activeRuns) {
    clearActiveEmbeddedRun(sessionId, handle);
  }
  activeRuns.clear();
  resetGatewayWorkAdmission();
});

describe("waitForGatewayActiveWork", () => {
  it.each([
    { runtime: "cli", taskKind: "exec", kind: "background-exec" },
    { runtime: "cli", taskKind: undefined, kind: "task" },
    { runtime: "cli", taskKind: "media", kind: "task" },
    { runtime: "subagent", taskKind: "exec", kind: "task" },
  ] as const)(
    "reports $runtime/$taskKind task ownership without changing counts",
    ({ runtime, taskKind, kind }) => {
      const task = {
        taskId: "task-owned",
        runId: "exec:owned-process",
        status: "running" as const,
        runtime,
        taskKind,
        label: "CLI command",
        title: "Background CLI command",
      };
      const snapshot = createGatewayActiveWorkSnapshot({
        getQueueSize: () => 0,
        getPendingReplies: () => 0,
        getEmbeddedRuns: () => 0,
        getBackgroundExecSessions: () => 1,
        getCronRuns: () => 0,
        getActiveTasks: () => 1,
        getTaskBlockers: () => [task],
        getRootRequests: () => 0,
        getSessionAdmissions: () => 0,
        getSessionMutations: () => 0,
        getChatRuns: () => 0,
        getQueuedTurns: () => 0,
        getTerminalPersistence: () => 0,
        getTerminalSessions: () => 0,
      });

      expect(snapshot.idle).toBe(false);
      expect(snapshot.counts).toMatchObject({
        backgroundExecSessions: 1,
        activeTasks: 1,
        totalActive: 2,
      });
      expect(snapshot.blockers.map((blocker) => blocker.kind)).toEqual(["background-exec", kind]);
      expect(snapshot.blockers[1]?.task).toEqual({
        taskId: "task-owned",
        runId: "exec:owned-process",
        status: "running",
        runtime,
        label: "CLI command",
        title: "Background CLI command",
      });
      expect(
        Value.Check(GatewaySuspendPrepareResultSchema, {
          status: "draining",
          suspensionId: "held-owner",
          expiresAtMs: 120_000,
          retryAfterMs: 20_000,
          activeCount: snapshot.counts.totalActive,
          blockers: snapshot.blockers,
        }),
      ).toBe(true);
    },
  );

  it("keeps omitted process-task details as conservative task blockers", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => ({
      taskId: `task-${index}`,
      runtime: "cli" as const,
      taskKind: "exec",
      status: "running" as const,
    }));
    const snapshot = createGatewayActiveWorkSnapshot({
      getActiveTasks: () => 9,
      getTaskBlockers: () => tasks,
    });

    expect(snapshot.idle).toBe(false);
    expect(snapshot.counts.activeTasks).toBe(9);
    expect(snapshot.blockers.filter((blocker) => blocker.task)).toHaveLength(8);
    expect(snapshot.blockers.at(-1)).toEqual({
      kind: "task",
      count: 1,
      message: "1 additional active background task run(s)",
    });
  });

  it("returns the final canonical blockers when its deadline expires", async () => {
    const sessionId = "probe-gateway-active-work-timeout";
    const handle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    activeRuns.set(sessionId, handle);
    setActiveEmbeddedRun(sessionId, handle);

    const result = await waitForGatewayActiveWork(0);

    expect(result.drained).toBe(false);
    expect(result.snapshot.counts.embeddedRuns).toBe(1);
    expect(result.snapshot.blockers).toContainEqual({
      kind: "embedded-run",
      count: 1,
      message: "1 active embedded run(s)",
    });
  });

  it("names active root request holders in deterministic order", async () => {
    const first = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");
    const second = tryBeginGatewayRootWorkAdmission("cron:timer-tick");
    const third = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");

    try {
      const result = await waitForGatewayActiveWork(0);

      expect(result.snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 3,
        message: "3 active gateway request(s): cron:timer-tick, ws:sessions.subscribe (2)",
      });
    } finally {
      first?.release();
      second?.release();
      third?.release();
    }
  });

  it("does not mix default holders into an overridden root count", () => {
    const admission = tryBeginGatewayRootWorkAdmission("ws:agent");
    try {
      const snapshot = createGatewayActiveWorkSnapshot({ getRootRequests: () => 1 });

      expect(snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 1,
        message: "1 active gateway request(s)",
      });
    } finally {
      admission?.release();
    }
  });
});
