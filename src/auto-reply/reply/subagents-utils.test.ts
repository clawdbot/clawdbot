import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
} from "./subagents-utils.js";

const NOW_MS = 1_700_000_000_000;

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const id = overrides.runId ?? "run-default";
  return {
    runId: id,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${id}`,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "main",
    task: overrides.task ?? "default task",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? NOW_MS - 2_000,
    ...overrides,
  };
}

function resolveTarget(runs: SubagentRunRecord[], token: string | undefined) {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: 30,
    label: (entry) => resolveSubagentLabel(entry),
    aliases: (entry) => (entry.taskName ? [entry.taskName] : []),
    errors: {
      missingTarget: "missing",
      invalidIndex: (value) => `invalid:${value}`,
      unknownSession: (value) => `unknown-session:${value}`,
      ambiguousLabel: (value) => `ambiguous-label:${value}`,
      ambiguousLabelPrefix: (value) => `ambiguous-prefix:${value}`,
      ambiguousRunIdPrefix: (value) => `ambiguous-run:${value}`,
      unknownTarget: (value) => `unknown:${value}`,
    },
  });
}

function expectResolvedRunId(
  runs: SubagentRunRecord[],
  token: string | undefined,
  expectedRunId: string,
): void {
  const resolved = resolveTarget(runs, token);
  if (!resolved.entry) {
    throw new Error(`Expected ${String(token)} to resolve, got ${resolved.error ?? "no target"}`);
  }
  expect(resolved.entry.runId).toBe(expectedRunId);
}

describe("subagents utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves subagent label with fallback", () => {
    expect(resolveSubagentLabel(makeRun({ label: "  runner " }))).toBe("runner");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: "  task value " }))).toBe("task value");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: " " }), "fallback")).toBe("fallback");
  });

  it("sorts by startedAt then createdAt descending", () => {
    const sorted = sortSubagentRuns([
      makeRun({ runId: "a", createdAt: 10 }),
      makeRun({ runId: "b", startedAt: 15, createdAt: 5 }),
      makeRun({ runId: "c", startedAt: 12, createdAt: 20 }),
    ]);
    expect(sorted.map((entry) => entry.runId)).toEqual(["b", "c", "a"]);
  });

  it("selects last from sorted runs", () => {
    const runs = [
      makeRun({ runId: "old", createdAt: NOW_MS - 2_000 }),
      makeRun({ runId: "new", createdAt: NOW_MS - 500 }),
    ];
    expectResolvedRunId(runs, " last ", "new");
  });

  it("resolves numeric index from running then recent finished order", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const runs = [
      makeRun({
        runId: "running",
        label: "running",
        createdAt: NOW_MS - 8_000,
      }),
      makeRun({
        runId: "recent-finished",
        label: "recent",
        createdAt: NOW_MS - 6_000,
        endedAt: NOW_MS - 60_000,
      }),
      makeRun({
        runId: "old-finished",
        label: "old",
        createdAt: NOW_MS - 7_000,
        endedAt: NOW_MS - 2 * 60 * 60 * 1_000,
      }),
    ];

    expectResolvedRunId(runs, "1", "running");
    expectResolvedRunId(runs, "2", "recent-finished");
    expect(resolveTarget(runs, "3").error).toBe("invalid:3");
  });

  it("resolves session key target and unknown session errors", () => {
    const run = makeRun({ runId: "abc123", childSessionKey: "agent:beta:subagent:xyz" });
    expectResolvedRunId([run], "agent:beta:subagent:xyz", "abc123");
    expect(resolveTarget([run], "agent:beta:subagent:missing").error).toBe(
      "unknown-session:agent:beta:subagent:missing",
    );
  });

  it("resolves exact label, prefix, run-id prefix and ambiguity errors", () => {
    const runs = [
      makeRun({ runId: "run-alpha-1", label: "Alpha Core" }),
      makeRun({ runId: "run-alpha-2", label: "Alpha Orbit" }),
      makeRun({ runId: "run-beta-1", label: "Beta Worker" }),
    ];

    expectResolvedRunId(runs, "beta worker", "run-beta-1");
    expectResolvedRunId(runs, "beta", "run-beta-1");
    expectResolvedRunId(runs, "run-beta", "run-beta-1");

    expectResolvedRunId(runs, "alpha core", "run-alpha-1");
    expect(resolveTarget(runs, "alpha").error).toBe("ambiguous-prefix:alpha");
    expect(resolveTarget(runs, "run-alpha").error).toBe("ambiguous-run:run-alpha");
    expect(resolveTarget(runs, "missing").error).toBe("unknown:missing");
    expect(resolveTarget(runs, undefined).error).toBe("missing");
  });

  it("returns ambiguous exact label error before prefix/run id matching", () => {
    const runs = [
      makeRun({ runId: "run-a", label: "dup" }),
      makeRun({ runId: "run-b", label: "dup" }),
    ];
    expect(resolveTarget(runs, "dup").error).toBe("ambiguous-label:dup");
  });

  it("resolves stable taskName aliases before labels and run ids", () => {
    const runs = [
      makeRun({ runId: "run-review-1", label: "Review", taskName: "code_review" }),
      makeRun({ runId: "run-review-2", label: "Review copy", taskName: "copy_review" }),
    ];

    expectResolvedRunId(runs, "code_review", "run-review-1");
    expectResolvedRunId(runs, "copy_", "run-review-2");
  });

  it("preserves exact label targets before taskName prefix aliases", () => {
    const runs = [
      makeRun({ runId: "run-review-label", label: "review" }),
      makeRun({ runId: "run-review-docs", label: "docs", taskName: "review_docs" }),
    ];

    expectResolvedRunId(runs, "review", "run-review-label");
    expectResolvedRunId(runs, "review_", "run-review-docs");
  });

  it("ignores stale duplicate taskName aliases when a current run reuses the handle", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const runs = [
      makeRun({
        runId: "run-old-review",
        childSessionKey: "agent:main:subagent:old-review",
        label: "Old review",
        taskName: "review_subagents",
        createdAt: NOW_MS - 2 * 60 * 60 * 1_000,
        endedAt: NOW_MS - 90 * 60 * 1_000,
      }),
      makeRun({
        runId: "run-current-review",
        childSessionKey: "agent:main:subagent:current-review",
        label: "Current review",
        taskName: "review_subagents",
        createdAt: NOW_MS - 1_000,
      }),
    ];

    expectResolvedRunId(runs, "review_subagents", "run-current-review");
  });

  it("prefers the current live row when stale and current runs share a label on one child session", () => {
    const runs = [
      makeRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:worker",
        label: "same worker",
        createdAt: NOW_MS - 10_000,
        startedAt: NOW_MS - 10_000,
        endedAt: NOW_MS - 5_000,
      }),
      makeRun({
        runId: "run-new",
        childSessionKey: "agent:main:subagent:worker",
        label: "same worker",
        createdAt: NOW_MS - 1_000,
        startedAt: NOW_MS - 1_000,
      }),
    ];

    expectResolvedRunId(runs, "same worker", "run-new");
  });
});
