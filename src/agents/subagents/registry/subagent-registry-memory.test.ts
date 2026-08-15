import { afterEach, describe, expect, it } from "vitest";
import {
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  subagentRuns,
} from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(runId: string, childSessionKey: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running" },
  };
}

afterEach(() => {
  subagentRuns.clear();
});

describe("subagent run memory indexes", () => {
  it("tracks child-session generations across replacement, deletion, and clear", () => {
    const first = createRun("run-first", "agent:main:subagent:shared");
    const second = createRun("run-second", "agent:main:subagent:shared");
    subagentRuns.set(first.runId, first);
    subagentRuns.set(second.runId, second);

    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([first, second]);

    const replacement = createRun("run-first", "agent:main:subagent:replacement");
    subagentRuns.set(replacement.runId, replacement);
    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([second]);
    expect([...getSubagentRunsForChildSession(replacement.childSessionKey)]).toEqual([replacement]);

    subagentRuns.delete(second.runId);
    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([]);

    subagentRuns.clear();
    expect([...getSubagentRunsForChildSession(replacement.childSessionKey)]).toEqual([]);
  });

  it("tracks every collector group member across replacement, deletion, and clear", () => {
    const requesterSessionKey = "agent:main:requester";
    const first = {
      ...createRun("run-first", "agent:main:subagent:first"),
      requesterSessionKey,
      collect: true,
      groupId: "swarm:shared",
      collectorCompletion: { status: "done" as const },
    };
    const incomplete = {
      ...createRun("run-incomplete", "agent:main:subagent:incomplete"),
      requesterSessionKey,
      collect: true,
      groupId: "swarm:shared",
    };
    subagentRuns.set(first.runId, first);
    subagentRuns.set(incomplete.runId, incomplete);

    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([
      [first.runId, first],
      [incomplete.runId, incomplete],
    ]);

    const replacement = { ...first, groupId: "swarm:replacement" };
    subagentRuns.set(replacement.runId, replacement);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([
      [incomplete.runId, incomplete],
    ]);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:replacement")]).toEqual(
      [[replacement.runId, replacement]],
    );

    subagentRuns.delete(incomplete.runId);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([]);

    subagentRuns.clear();
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:replacement")]).toEqual(
      [],
    );
  });
});
