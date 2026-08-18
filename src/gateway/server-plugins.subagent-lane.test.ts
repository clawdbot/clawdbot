import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { setGatewayDedupeEntry } from "./agent-turn/agent-job.js";
import { createGatewaySubagentRuntime } from "./server-plugins.js";
import type { DedupeEntry } from "./server-shared.js";

function createGate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("plugin subagent shared lane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setCommandLaneConcurrency(CommandLane.Subagent, 1);
  });

  afterEach(() => {
    clearCommandLane(CommandLane.Subagent);
    setCommandLaneConcurrency(CommandLane.Subagent, 1);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("holds queued dreaming phases beyond 60 seconds without consuming their run budgets", async () => {
    const runtime = createGatewaySubagentRuntime();
    const blocker = createGate();
    const trace = ["maxConcurrent=1"];
    const fallbacks: string[] = [];
    const deletions: string[] = [];

    const held = enqueueCommandInLane(CommandLane.Subagent, async () => {
      trace.push("dequeue hold");
      await blocker.promise;
      trace.push("release hold");
    });
    const runPhase = async (phase: "narrative" | "consolidation") => {
      const runId = `dreaming-${phase}`;
      trace.push(`enqueue ${phase}`);
      setGatewayDedupeEntry({
        dedupe: new Map<string, DedupeEntry>(),
        key: `agent:${runId}`,
        entry: { ts: Date.now(), ok: true, payload: { runId, status: "in_flight" } },
      });
      const queued = enqueueCommandInLane(CommandLane.Subagent, async () => {
        trace.push(`dequeue ${phase}`, `start ${phase}`);
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: Date.now(), endedAt: Date.now() },
        });
        trace.push(`terminal ${phase}`);
      });
      const terminal = await runtime.waitForRun({ runId, timeoutMs: 60_000 });
      if (terminal.status !== "ok") {
        fallbacks.push(phase);
        deletions.push(phase);
      } else {
        trace.push(`output ${phase}`);
      }
      await queued;
      trace.push(`cleanup ${phase}`);
    };

    const narrative = runPhase("narrative");
    const consolidation = runPhase("consolidation");
    await vi.advanceTimersByTimeAsync(60_001);

    expect(getCommandLaneSnapshot(CommandLane.Subagent)).toMatchObject({
      maxConcurrent: 1,
      activeCount: 1,
      queuedCount: 2,
    });
    expect(fallbacks).toEqual([]);
    expect(deletions).toEqual([]);

    blocker.release();
    await Promise.all([held, narrative, consolidation]);

    expect(fallbacks).toEqual([]);
    expect(deletions).toEqual([]);
    const expectOrder = (...entries: string[]) => {
      const positions = entries.map((entry) => trace.indexOf(entry));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions.slice(1).every((position, index) => position > positions[index]!)).toBe(
        true,
      );
    };
    expectOrder("release hold", "dequeue narrative", "start narrative", "terminal narrative");
    expectOrder("terminal narrative", "output narrative", "cleanup narrative");
    expectOrder("dequeue narrative", "dequeue consolidation", "start consolidation");
    expectOrder("start consolidation", "terminal consolidation", "output consolidation");
    expectOrder("output consolidation", "cleanup consolidation");
  });
});
