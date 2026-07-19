import { describe, expect, it } from "vitest";
import { classifyPrForSweep, runPrCiSweeper } from "../../scripts/github/pr-ci-sweeper.mjs";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

function pr(overrides: Partial<Parameters<typeof classifyPrForSweep>[0]["pr"]> = {}) {
  return {
    draft: false,
    created_at: new Date(NOW - 2 * HOURS).toISOString(),
    updated_at: new Date(NOW - 30 * MINUTES).toISOString(),
    mergeable: true,
    auto_merge: null,
    ...overrides,
  };
}

describe("classifyPrForSweep", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof classifyPrForSweep>[0];
    expected: ReturnType<typeof classifyPrForSweep>;
  }> = [
    {
      name: "re-fires when no CI run attached",
      input: { pr: pr(), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "refire", reason: "ci-run-missing" },
    },
    {
      name: "re-fires when only startup failures attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "startup_failure" }],
        botCloseCount: 1,
        now: NOW,
      },
      expected: { action: "refire", reason: "ci-startup-failure" },
    },
    {
      name: "skips drafts",
      input: { pr: pr({ draft: true }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "skip", reason: "draft" },
    },
    {
      name: "skips PRs outside the 24h lookback",
      input: {
        pr: pr({ created_at: new Date(NOW - 25 * HOURS).toISOString() }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "outside-lookback" },
    },
    {
      name: "skips recently updated PRs so merge-ref computation can settle",
      input: {
        pr: pr({ updated_at: new Date(NOW - 5 * MINUTES).toISOString() }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "recently-updated" },
    },
    {
      name: "skips merge conflicts whose merge ref legitimately cannot exist",
      input: { pr: pr({ mergeable: false }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "skip", reason: "merge-conflict" },
    },
    {
      name: "skips PRs with auto-merge enabled (close would cancel it)",
      input: {
        pr: pr({ auto_merge: { merge_method: "squash" } }),
        ciRuns: [],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "auto-merge-enabled" },
    },
    {
      name: "treats a completed run as attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "success" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a queued run (null conclusion) as attached",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: null }, { conclusion: "startup_failure" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a failed run as attached (rerunnable, not sweepable)",
      input: {
        pr: pr(),
        ciRuns: [{ conclusion: "failure" }],
        botCloseCount: 0,
        now: NOW,
      },
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "stops after two bot closes",
      input: { pr: pr(), ciRuns: [], botCloseCount: 2, now: NOW },
      expected: { action: "skip", reason: "refire-budget-exhausted" },
    },
    {
      name: "re-fires on unknown mergeability (stuck merge-ref IS the pathology)",
      input: { pr: pr({ mergeable: null }), ciRuns: [], botCloseCount: 0, now: NOW },
      expected: { action: "refire", reason: "ci-run-missing" },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(classifyPrForSweep(input)).toEqual(expected);
  });
});

type FakeCall = { method: string; args: Record<string, unknown> };

function fakeGithub(options: {
  prs: Array<Record<string, unknown>>;
  runsBySha: Record<string, Array<{ conclusion: string | null; event?: string }>>;
  events?: Array<Record<string, unknown>>;
}) {
  const calls: FakeCall[] = [];
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const github = {
    paginate: (endpoint: { endpointName: string }, args: Record<string, unknown>) => {
      record(endpoint.endpointName, args);
      if (endpoint.endpointName === "pulls.list") {
        return Promise.resolve(options.prs);
      }
      if (endpoint.endpointName === "actions.listWorkflowRuns") {
        return Promise.resolve(
          (options.runsBySha[args.head_sha as string] ?? []).map((run) => ({
            event: run.event ?? "pull_request",
            conclusion: run.conclusion,
          })),
        );
      }
      if (endpoint.endpointName === "issues.listEvents") {
        return Promise.resolve(options.events ?? []);
      }
      throw new Error(`unexpected paginate ${endpoint.endpointName}`);
    },
    rest: {
      pulls: {
        list: { endpointName: "pulls.list" },
        get: (args: Record<string, unknown>) => {
          record("pulls.get", args);
          const match = options.prs.find((entry) => entry.number === args.pull_number);
          return Promise.resolve({ data: match });
        },
        update: (args: Record<string, unknown>) => {
          record("pulls.update", args);
          return Promise.resolve({});
        },
      },
      actions: { listWorkflowRuns: { endpointName: "actions.listWorkflowRuns" } },
      issues: {
        listEvents: { endpointName: "issues.listEvents" },
        createComment: (args: Record<string, unknown>) => {
          record("issues.createComment", args);
          return Promise.resolve({});
        },
      },
    },
  };
  return { github, calls };
}

const context = { repo: { owner: "openclaw", repo: "openclaw" } };
const core = { info: () => {}, setFailed: () => {} };

describe("runPrCiSweeper", () => {
  it("classifies a dropped-CI PR as refire in dry-run without mutating", async () => {
    const dropped = {
      ...pr(),
      number: 7,
      state: "open",
      head: { sha: "a".repeat(40) },
    };
    const attached = {
      ...pr(),
      number: 8,
      state: "open",
      head: { sha: "b".repeat(40) },
    };
    const { github, calls } = fakeGithub({
      prs: [dropped, attached],
      runsBySha: {
        [dropped.head.sha]: [{ conclusion: "startup_failure" }],
        [attached.head.sha]: [{ conclusion: "success" }],
      },
    });
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      dryRun: true,
      appSlug: "openclaw-barnacle",
    });
    expect(results).toEqual([
      { number: 7, sha: "a".repeat(12), action: "refire", reason: "ci-startup-failure" },
    ]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it("closes and reopens a dropped-CI PR in live mode", async () => {
    const dropped = {
      ...pr(),
      number: 9,
      state: "open",
      head: { sha: "c".repeat(40) },
    };
    const { github, calls } = fakeGithub({ prs: [dropped], runsBySha: {} });
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      appSlug: "openclaw-barnacle",
    });
    expect(results).toEqual([
      { number: 9, sha: "c".repeat(12), action: "refire", reason: "ci-run-missing" },
    ]);
    expect(
      calls.filter((call) => call.method === "pulls.update").map((call) => call.args.state),
    ).toEqual(["closed", "open"]);
  });
});
