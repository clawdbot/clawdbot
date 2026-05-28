import { beforeEach, describe, expect, it } from "vitest";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import {
  countPendingDescendantRunsFromRuns,
  listRunsForControllerFromRuns,
} from "../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../agents/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import { buildSubagentsStatusLine } from "./commands-status-subagents.js";

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("subagents status", () => {
  it.each([
    {
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      verboseLevel: "on" as const,
      expectedText: [] as string[],
      unexpectedText: ["Subagents:"],
    },
    {
      name: "includes subagent count and active detail in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
      },
      verboseLevel: "off" as const,
      expectedText: ["🤖 Subagents: 1 active", "  • do thing · 4s"],
      unexpectedText: [] as string[],
    },
    {
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
        addSubagentRunForTests({
          runId: "run-2",
          childSessionKey: "agent:main:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 900,
          startedAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 1 active", "· 1 done", "  • do thing · 4s"],
      unexpectedText: [] as string[],
    },
    {
      name: "preserves verbose done-only summary",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:done-a",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
          endedAt: 2000,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 0 active · 1 done"],
      unexpectedText: ["  • finished task"],
    },
  ])("$name", ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
    const runs = listRunsForControllerFromRuns(runsSnapshot, "agent:main:main");
    const text =
      buildSubagentsStatusLine({
        runs,
        verboseEnabled: verboseLevel === "on",
        pendingDescendantsForRun: (entry) =>
          countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey),
        now: 5000,
      }) ?? "";
    for (const expected of expectedText) {
      expect(text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(text).not.toContain(blocked);
    }
  });
});
