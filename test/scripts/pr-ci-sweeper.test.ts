import { describe, expect, it } from "vitest";
import {
  classifyPrForSweep,
  classifyRunForRevive,
  runPrCiSweeper,
} from "../../scripts/github/pr-ci-sweeper.mjs";

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

describe("classifyRunForRevive", () => {
  const prCreatedAt = new Date(NOW - 2 * HOURS).toISOString();
  const cases: Array<{
    name: string;
    run: Parameters<typeof classifyRunForRevive>[0]["run"];
    expected: ReturnType<typeof classifyRunForRevive>;
  }> = [
    {
      name: "revives a cancelled pull_request_target run",
      run: {
        conclusion: "cancelled",
        event: "pull_request_target",
        run_attempt: 1,
        created_at: new Date(NOW - 1 * HOURS).toISOString(),
      },
      expected: { action: "revive", reason: "cancelled-pr-event-run" },
    },
    {
      name: "skips a run after two revives without progress",
      run: {
        conclusion: "cancelled",
        event: "pull_request",
        run_attempt: 3,
        created_at: new Date(NOW - 1 * HOURS).toISOString(),
      },
      expected: { action: "skip", reason: "revive-budget-exhausted" },
    },
    {
      name: "skips a non-cancelled run",
      run: {
        conclusion: "success",
        event: "pull_request_target",
        run_attempt: 1,
        created_at: new Date(NOW - 1 * HOURS).toISOString(),
      },
      expected: { action: "skip", reason: "not-cancelled" },
    },
    {
      name: "skips a cancelled run from an unrelated event",
      run: {
        conclusion: "cancelled",
        event: "workflow_dispatch",
        run_attempt: 1,
        created_at: new Date(NOW - 1 * HOURS).toISOString(),
      },
      expected: { action: "skip", reason: "unsupported-event" },
    },
  ];

  it.each(cases)("$name", ({ run, expected }) => {
    expect(
      classifyRunForRevive({
        run: {
          head_branch: "automation/refresh",
          head_repository: { full_name: "openclaw/openclaw" },
          ...run,
        },
        prCreatedAt,
        prHeadBranch: "automation/refresh",
        repoFullName: "openclaw/openclaw",
      }),
    ).toEqual(expected);
  });

  it("skips a run triggered from a different head branch", () => {
    expect(
      classifyRunForRevive({
        run: {
          conclusion: "cancelled",
          event: "pull_request_target",
          run_attempt: 1,
          created_at: new Date(NOW - 1 * HOURS).toISOString(),
          head_branch: "some/other-branch",
        },
        prCreatedAt,
        prHeadBranch: "automation/refresh",
        repoFullName: "openclaw/openclaw",
      }),
    ).toEqual({ action: "skip", reason: "different-head-branch" });
  });

  it("skips a run with a null head branch", () => {
    expect(
      classifyRunForRevive({
        run: {
          conclusion: "cancelled",
          event: "pull_request",
          run_attempt: 1,
          created_at: new Date(NOW - 1 * HOURS).toISOString(),
          head_branch: null,
          head_repository: { full_name: "openclaw/openclaw" },
        },
        prCreatedAt,
        prHeadBranch: "automation/refresh",
        repoFullName: "openclaw/openclaw",
      }),
    ).toEqual({ action: "skip", reason: "different-head-branch" });
  });

  it("skips a run with no head repository metadata", () => {
    expect(
      classifyRunForRevive({
        run: {
          conclusion: "cancelled",
          event: "pull_request",
          run_attempt: 1,
          created_at: new Date(NOW - 1 * HOURS).toISOString(),
          head_branch: "automation/refresh",
        },
        prCreatedAt,
        prHeadBranch: "automation/refresh",
        repoFullName: "openclaw/openclaw",
      }),
    ).toEqual({ action: "skip", reason: "fork-head-repository" });
  });

  it("skips a run whose head repository is a fork", () => {
    expect(
      classifyRunForRevive({
        run: {
          conclusion: "cancelled",
          event: "pull_request",
          run_attempt: 1,
          created_at: new Date(NOW - 1 * HOURS).toISOString(),
          head_branch: "automation/refresh",
          head_repository: { full_name: "fork/openclaw" },
        },
        prCreatedAt,
        prHeadBranch: "automation/refresh",
        repoFullName: "openclaw/openclaw",
      }),
    ).toEqual({ action: "skip", reason: "fork-head-repository" });
  });

  it("skips a run created before the current PR existed", () => {
    expect(
      classifyRunForRevive({
        run: {
          conclusion: "cancelled",
          event: "pull_request_target",
          run_attempt: 1,
          created_at: new Date(NOW - 3 * HOURS).toISOString(),
        },
        prCreatedAt,
      }),
    ).toEqual({ action: "skip", reason: "predates-pr" });
  });
});

type FakeCall = { method: string; args: Record<string, unknown> };
type FakeWorkflowRun = Parameters<typeof classifyRunForRevive>[0]["run"] & { id: number };
type FakeCheckRun = {
  status?: string;
  conclusion: string | null;
  app: { slug: string } | null;
  details_url: string | null;
};

function fakeGithub(options: {
  prs: Array<Record<string, unknown>>;
  runsBySha: Record<string, Array<{ conclusion: string | null; event?: string }>>;
  checksByRef?: Record<string, FakeCheckRun[]>;
  workflowRunsById?: Record<number, FakeWorkflowRun>;
  pullsGetByNumber?: Record<number, Record<string, unknown>>;
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
          (options.runsBySha[args.head_sha as string] ?? [])
            .map((run) => ({
              event: run.event ?? "pull_request",
              conclusion: run.conclusion,
            }))
            .filter((run) => !args.event || run.event === args.event),
        );
      }
      if (endpoint.endpointName === "checks.listForRef") {
        return Promise.resolve(options.checksByRef?.[args.ref as string] ?? []);
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
          const match =
            options.pullsGetByNumber?.[args.pull_number as number] ??
            options.prs.find((entry) => entry.number === args.pull_number);
          return Promise.resolve({ data: match });
        },
        update: (args: Record<string, unknown>) => {
          record("pulls.update", args);
          return Promise.resolve({});
        },
      },
      actions: {
        listWorkflowRuns: { endpointName: "actions.listWorkflowRuns" },
        getWorkflowRun: (args: Record<string, unknown>) => {
          record("actions.getWorkflowRun", args);
          return Promise.resolve({ data: options.workflowRunsById?.[args.run_id as number] });
        },
        reRunWorkflow: (args: Record<string, unknown>) => {
          record("actions.reRunWorkflow", args);
          return Promise.resolve({});
        },
      },
      checks: { listForRef: { endpointName: "checks.listForRef" } },
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

function recordingCore() {
  const logs: string[] = [];
  return {
    core: {
      info: (message: string) => logs.push(message),
      setFailed: () => {},
    },
    logs,
  };
}

function autoMergePr(number: number, headSha: string) {
  return {
    ...pr({ auto_merge: { merge_method: "squash" } }),
    number,
    state: "open",
    head: { sha: headSha, ref: "automation/refresh" },
  };
}

function githubActionsCheck(runId: number, overrides: Partial<FakeCheckRun> = {}): FakeCheckRun {
  return {
    conclusion: "cancelled",
    status: "completed",
    app: { slug: "github-actions" },
    details_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/456`,
    ...overrides,
  };
}

function cancelledRun(runId: number, overrides: Partial<FakeWorkflowRun> = {}): FakeWorkflowRun {
  return {
    id: runId,
    conclusion: "cancelled",
    event: "pull_request_target",
    run_attempt: 1,
    created_at: new Date(NOW - 1 * HOURS).toISOString(),
    head_branch: "automation/refresh",
    head_repository: { full_name: "openclaw/openclaw" },
    ...overrides,
  };
}

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
      now: NOW,
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
      now: NOW,
    });
    expect(results).toEqual([
      { number: 9, sha: "c".repeat(12), action: "refire", reason: "ci-run-missing" },
    ]);
    expect(
      calls.filter((call) => call.method === "pulls.update").map((call) => call.args.state),
    ).toEqual(["closed", "open"]);
  });

  it("revives a cancelled GitHub Actions check exactly once", async () => {
    const generated = autoMergePr(10, "d".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        // One workflow produces multiple checks; dedupe their shared run id.
        [generated.head.sha]: [githubActionsCheck(1234), githubActionsCheck(1234)],
      },
      workflowRunsById: { 1234: cancelledRun(1234) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([
      {
        method: "actions.reRunWorkflow",
        args: { owner: "openclaw", repo: "openclaw", run_id: 1234 },
      },
    ]);
    // Discovery plus the pre-mutation revalidation both list the head's checks.
    const checkLists = calls.filter((call) => call.method === "checks.listForRef");
    expect(checkLists).toHaveLength(2);
    for (const call of checkLists) {
      expect(call.args).toEqual({
        owner: "openclaw",
        repo: "openclaw",
        ref: generated.head.sha,
        filter: "latest",
        per_page: 100,
      });
    }
    // Discovery plus the pre-mutation attempt reclassification both fetch the run.
    expect(calls.filter((call) => call.method === "actions.getWorkflowRun")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it("does not revive a run triggered from a different branch on a shared commit", async () => {
    const generated = autoMergePr(14, "f".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(4321)] },
      workflowRunsById: { 4321: cancelledRun(4321, { head_branch: "some/foreign-branch" }) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("defers revive while the head has active checks", async () => {
    const generated = autoMergePr(15, "9".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(7777),
          githubActionsCheck(8888, { status: "in_progress", conclusion: null }),
        ],
      },
      workflowRunsById: { 7777: cancelledRun(7777) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips cancelled checks from non-GitHub-Actions apps", async () => {
    const generated = autoMergePr(11, "e".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [githubActionsCheck(2345, { app: { slug: "external-ci" } })],
      },
      workflowRunsById: { 2345: cancelledRun(2345) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.getWorkflowRun")).toEqual([]);
    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips a workflow run that predates the PR", async () => {
    const generated = autoMergePr(12, "f".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(3456)] },
      workflowRunsById: {
        3456: cancelledRun(3456, {
          created_at: new Date(Date.parse(generated.created_at) - MINUTES).toISOString(),
        }),
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("skips a workflow run at the revive attempt limit", async () => {
    const generated = autoMergePr(13, "1".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(4567)] },
      workflowRunsById: { 4567: cancelledRun(4567, { run_attempt: 3 }) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("logs a dry-run revive without rerunning or closing", async () => {
    const generated = autoMergePr(14, "2".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(5678)] },
      workflowRunsById: { 5678: cancelledRun(5678, { run_attempt: 2 }) },
    });
    const { core: loggedCore, logs } = recordingCore();

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      dryRun: true,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
    expect(logs).toContain("pr-ci-sweeper: dry-run, would revive cancelled run 5678 for #14");
  });

  it("does not rerun when the PR head changes during revalidation", async () => {
    const generated = autoMergePr(15, "3".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: { [generated.head.sha]: [githubActionsCheck(6789)] },
      workflowRunsById: { 6789: cancelledRun(6789) },
      pullsGetByNumber: {
        [generated.number]: { ...generated, head: { sha: "4".repeat(40) } },
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });
});
