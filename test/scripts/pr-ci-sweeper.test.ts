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
    prOverrides?: Partial<Parameters<typeof classifyPrForSweep>[0]["pr"]>;
    ciRuns?: Parameters<typeof classifyPrForSweep>[0]["ciRuns"];
    botCloseCount?: number;
    expected: ReturnType<typeof classifyPrForSweep>;
  }> = [
    {
      name: "re-fires when no CI run attached",
      expected: { action: "refire", reason: "ci-run-missing" },
    },
    {
      name: "re-fires when only startup failures attached",
      ciRuns: [{ conclusion: "startup_failure" }],
      botCloseCount: 1,
      expected: { action: "refire", reason: "ci-startup-failure" },
    },
    {
      name: "skips drafts",
      prOverrides: { draft: true },
      expected: { action: "skip", reason: "draft" },
    },
    {
      name: "skips recently updated PRs so merge-ref computation can settle",
      prOverrides: { updated_at: new Date(NOW - 5 * MINUTES).toISOString() },
      expected: { action: "skip", reason: "recently-updated" },
    },
    {
      name: "skips merge conflicts whose merge ref legitimately cannot exist",
      prOverrides: { mergeable: false },
      expected: { action: "skip", reason: "merge-conflict" },
    },
    {
      name: "skips PRs with auto-merge enabled (close would cancel it)",
      prOverrides: { auto_merge: { merge_method: "squash" } },
      expected: { action: "skip", reason: "auto-merge-enabled" },
    },
    {
      name: "treats a completed run as attached",
      ciRuns: [{ conclusion: "success" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a queued run (null conclusion) as attached",
      ciRuns: [{ conclusion: null }, { conclusion: "startup_failure" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "treats a failed run as attached (rerunnable, not sweepable)",
      ciRuns: [{ conclusion: "failure" }],
      expected: { action: "skip", reason: "ci-attached" },
    },
    {
      name: "stops after two bot closes",
      botCloseCount: 2,
      expected: { action: "skip", reason: "refire-budget-exhausted" },
    },
    {
      name: "re-fires on unknown mergeability (stuck merge-ref IS the pathology)",
      prOverrides: { mergeable: null },
      expected: { action: "refire", reason: "ci-run-missing" },
    },
  ];

  it.each(cases)("$name", ({ prOverrides, ciRuns = [], botCloseCount = 0, expected }) => {
    expect(classifyPrForSweep({ pr: pr(prOverrides), ciRuns, botCloseCount, now: NOW })).toEqual(
      expected,
    );
  });
});

describe("classifyRunForRevive", () => {
  const prCreatedAt = new Date(NOW - 2 * HOURS).toISOString();
  const cases: Array<{
    name: string;
    runOverrides?: Partial<Parameters<typeof classifyRunForRevive>[0]["run"]>;
    pullCreatedAt?: string;
    expectedHeadBranch?: string;
    expectedRepoFullName?: string;
    expected: ReturnType<typeof classifyRunForRevive>;
  }> = [
    {
      name: "revives a cancelled pull_request_target run",
      expected: { action: "revive", reason: "cancelled-pr-event-run" },
    },
    {
      name: "revives a cancelled pull_request run",
      runOverrides: { event: "pull_request" },
      expected: { action: "revive", reason: "cancelled-pr-event-run" },
    },
    {
      name: "skips a run after two revives without progress",
      runOverrides: { event: "pull_request", run_attempt: 3 },
      expected: { action: "skip", reason: "revive-budget-exhausted" },
    },
    {
      name: "skips a non-cancelled run",
      runOverrides: { conclusion: "success" },
      expected: { action: "skip", reason: "not-cancelled" },
    },
    {
      name: "skips a cancelled run from an unrelated event",
      runOverrides: { event: "workflow_dispatch" },
      expected: { action: "skip", reason: "unsupported-event" },
    },
    {
      name: "skips a run triggered from a different head branch",
      runOverrides: { head_branch: "some/other-branch" },
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "skips a run with a null head branch",
      runOverrides: { head_branch: null },
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "fails closed when the expected and actual head branches are empty",
      runOverrides: { head_branch: "" },
      expectedHeadBranch: "",
      expected: { action: "skip", reason: "different-head-branch" },
    },
    {
      name: "skips a run with no head repository metadata",
      runOverrides: { head_repository: undefined },
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "skips a run whose head repository is a fork",
      runOverrides: { head_repository: { full_name: "fork/openclaw" } },
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "fails closed when the expected and actual head repositories are empty",
      runOverrides: { head_repository: { full_name: "" } },
      expectedRepoFullName: "",
      expected: { action: "skip", reason: "fork-head-repository" },
    },
    {
      name: "skips a run created before the current PR existed",
      runOverrides: { created_at: new Date(NOW - 3 * HOURS).toISOString() },
      expected: { action: "skip", reason: "predates-pr" },
    },
    {
      name: "fails closed when the workflow run creation time is invalid",
      runOverrides: { created_at: "not-a-date" },
      expected: { action: "skip", reason: "unverifiable-created-at" },
    },
    {
      name: "fails closed when the pull request creation time is invalid",
      pullCreatedAt: "not-a-date",
      expected: { action: "skip", reason: "unverifiable-created-at" },
    },
  ];

  it.each(cases)(
    "$name",
    ({
      runOverrides,
      pullCreatedAt = prCreatedAt,
      expectedHeadBranch = "automation/refresh",
      expectedRepoFullName = "openclaw/openclaw",
      expected,
    }) => {
      expect(
        classifyRunForRevive({
          run: cancelledRun(1, runOverrides),
          prCreatedAt: pullCreatedAt,
          prHeadBranch: expectedHeadBranch,
          repoFullName: expectedRepoFullName,
        }),
      ).toEqual(expected);
    },
  );
});

type FakeCall = { method: string; args: Record<string, unknown> };
type FakeWorkflowRun = Parameters<typeof classifyRunForRevive>[0]["run"] & {
  id: number;
  workflow_id: number | null;
};
type FakeCheckRun = {
  id: number;
  name: string;
  status?: string;
  conclusion: string | null;
  app: { slug: string } | null;
  details_url: string | null | undefined;
};

function fakeGithub(options: {
  prs: Array<Record<string, unknown>>;
  runsBySha: Record<
    string,
    Array<{ conclusion: string | null; event?: string; id?: number; status?: string }>
  >;
  checksByRef?: Record<string, FakeCheckRun[] | FakeCheckRun[][]>;
  workflowRunsById?: Record<number, FakeWorkflowRun>;
  workflowRunErrorsById?: Record<number, Error>;
  pullsGetByNumber?: Record<number, Record<string, unknown> | Array<Record<string, unknown>>>;
  events?: Array<Record<string, unknown>>;
  pageSize?: number;
}) {
  const calls: FakeCall[] = [];
  const pullsGetCallCounts = new Map<number, number>();
  const checksListCallCounts = new Map<string, number>();
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const github = {
    paginate: (
      endpoint: { endpointName: string },
      args: Record<string, unknown>,
      mapFn?: (response: { data: unknown[] }, done: () => void) => unknown[],
    ) => {
      record(endpoint.endpointName, args);
      // Emulate octokit's paged mapFn contract: the page where done() fires is
      // still included in the result, and later pages are never fetched.
      const paged = (items: unknown[]) => {
        if (!mapFn) {
          return Promise.resolve(items);
        }
        const pageSize = options.pageSize ?? Math.max(items.length, 1);
        const collected: unknown[] = [];
        let stopped = false;
        for (let start = 0; start < items.length; start += pageSize) {
          record(`${endpoint.endpointName}.page`, { start });
          collected.push(
            ...mapFn({ data: items.slice(start, start + pageSize) }, () => {
              stopped = true;
            }),
          );
          if (stopped) {
            break;
          }
        }
        return Promise.resolve(collected);
      };
      if (endpoint.endpointName === "pulls.list") {
        return paged(options.prs);
      }
      if (endpoint.endpointName === "actions.listWorkflowRuns") {
        return Promise.resolve(
          Array.from(options.runsBySha[args.head_sha as string] ?? [], (run) => ({
            ...run,
            event: run.event ?? "pull_request",
          })).filter((run) => !args.event || run.event === args.event),
        );
      }
      if (endpoint.endpointName === "checks.listForRef") {
        const ref = args.ref as string;
        const configured = options.checksByRef?.[ref] ?? [];
        if (Array.isArray(configured[0])) {
          const snapshots = configured as FakeCheckRun[][];
          const callIndex = checksListCallCounts.get(ref) ?? 0;
          checksListCallCounts.set(ref, callIndex + 1);
          return Promise.resolve(snapshots[Math.min(callIndex, snapshots.length - 1)] ?? []);
        }
        return Promise.resolve(configured as FakeCheckRun[]);
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
          const pullNumber = args.pull_number as number;
          const configured = options.pullsGetByNumber?.[pullNumber];
          const callIndex = pullsGetCallCounts.get(pullNumber) ?? 0;
          pullsGetCallCounts.set(pullNumber, callIndex + 1);
          const match = Array.isArray(configured)
            ? configured[Math.min(callIndex, configured.length - 1)]
            : (configured ?? options.prs.find((entry) => entry.number === pullNumber));
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
          const runId = args.run_id as number;
          const error = options.workflowRunErrorsById?.[runId];
          if (error) {
            return Promise.reject(error);
          }
          return Promise.resolve({ data: options.workflowRunsById?.[runId] });
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
    id: runId,
    name: "proof",
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
    workflow_id: 10,
    conclusion: "cancelled",
    event: "pull_request_target",
    run_attempt: 1,
    created_at: new Date(NOW - HOURS).toISOString(),
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
      { number: 8, sha: "b".repeat(12), action: "skip", reason: "ci-attached" },
    ]);
    expect(calls.filter((call) => call.method === "pulls.update")).toEqual([]);
  });

  it("logs a ci-attached skip with the attached run ids", async () => {
    const attached = {
      ...pr(),
      number: 21,
      state: "open",
      head: { sha: "5".repeat(40) },
    };
    const { github } = fakeGithub({
      prs: [attached],
      runsBySha: {
        [attached.head.sha]: [{ id: 30105208438, status: "completed", conclusion: "failure" }],
      },
    });
    const { core: loggedCore, logs } = recordingCore();
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      now: NOW,
    });
    expect(results).toEqual([
      { number: 21, sha: "5".repeat(12), action: "skip", reason: "ci-attached" },
    ]);
    expect(logs).toContain("pr-ci-sweeper: skip #21 (ci-attached: 30105208438:completed/failure)");
  });

  it("logs draft skips so every scanned PR has a decision", async () => {
    const draft = {
      ...pr({ draft: true }),
      number: 22,
      state: "open",
      head: { sha: "6".repeat(40) },
    };
    const { github, calls } = fakeGithub({ prs: [draft], runsBySha: {} });
    const { core: loggedCore, logs } = recordingCore();
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      now: NOW,
    });
    expect(results).toEqual([{ number: 22, sha: "6".repeat(12), action: "skip", reason: "draft" }]);
    expect(logs).toContain("pr-ci-sweeper: skip #22 (draft)");
    // Drafts skip before the per-head run lookup so they cost no Actions reads.
    expect(calls.filter((call) => call.method === "actions.listWorkflowRuns")).toEqual([]);
  });

  it("keeps logging decisions after the per-sweep re-fire cap", async () => {
    const dropped = Array.from({ length: 11 }, (_, index) => ({
      ...pr(),
      number: 100 + index,
      state: "open",
      head: { sha: index.toString(16).padStart(2, "0").repeat(20) },
    }));
    const { github, calls } = fakeGithub({ prs: dropped, runsBySha: {} });
    const { core: loggedCore, logs } = recordingCore();
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      dryRun: true,
      now: NOW,
    });
    expect(results.filter((entry) => entry.action === "refire")).toHaveLength(10);
    expect(results.at(-1)).toEqual({
      number: 110,
      sha: "0a".repeat(6),
      action: "skip",
      reason: "refire-cap-reached",
    });
    expect(logs).toContain("pr-ci-sweeper: skip #110 (refire-cap-reached)");
    // The capped PR is classified from list data only, never fetched.
    expect(
      calls.filter((call) => call.method === "pulls.get" && call.args.pull_number === 110),
    ).toEqual([]);
  });

  it("closes and reopens a dropped-CI PR without spending budget on stale heads", async () => {
    const dropped = Array.from({ length: 11 }, (_, index) => ({
      ...pr(),
      number: 200 + index,
      state: "open",
      head: { sha: index.toString(16).padStart(2, "0").repeat(20) },
    }));
    const pullsGetByNumber = Object.fromEntries(
      dropped
        .slice(0, 10)
        .map((candidate) => [
          candidate.number,
          [candidate, { ...candidate, head: { sha: "f".repeat(40) } }],
        ]),
    );
    const { github, calls } = fakeGithub({ prs: dropped, runsBySha: {}, pullsGetByNumber });
    const { core: loggedCore, logs } = recordingCore();

    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: loggedCore as never,
      appSlug: "openclaw-barnacle",
      now: NOW,
    });

    expect(results).toHaveLength(dropped.length);
    expect(results.slice(0, 10)).toEqual(
      dropped.slice(0, 10).map((candidate) => ({
        number: candidate.number,
        sha: candidate.head.sha.slice(0, 12),
        action: "skip",
        reason: "changed-during-sweep",
      })),
    );
    expect(results.at(-1)).toEqual({
      number: 210,
      sha: "0a".repeat(6),
      action: "refire",
      reason: "ci-run-missing",
    });
    expect(calls.filter((call) => call.method === "pulls.update").map((call) => call.args)).toEqual(
      [
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "closed" },
        { owner: "openclaw", repo: "openclaw", pull_number: 210, state: "open" },
      ],
    );
    expect(logs.at(-1)).toContain("1 re-fire");
  });

  it("stops listing pages once creation dates cross the lookback", async () => {
    const recent = { ...pr(), number: 30, state: "open", head: { sha: "7".repeat(40) } };
    const oldA = {
      ...pr({ created_at: new Date(NOW - 25 * HOURS).toISOString() }),
      number: 31,
      state: "open",
      head: { sha: "8".repeat(40) },
    };
    const oldB = {
      ...pr({ created_at: new Date(NOW - 30 * HOURS).toISOString() }),
      number: 32,
      state: "open",
      head: { sha: "9".repeat(40) },
    };
    const { github, calls } = fakeGithub({
      prs: [recent, oldA, oldB],
      runsBySha: {},
      pageSize: 1,
    });
    const results = await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      dryRun: true,
      now: NOW,
    });
    // Page 2 crossed the 24h creation horizon, so page 3 is never fetched and
    // the outside-lookback PR on page 2 stops the scan without a decision.
    expect(calls.filter((call) => call.method === "pulls.list.page")).toHaveLength(2);
    expect(results).toEqual([
      { number: 30, sha: "7".repeat(12), action: "refire", reason: "ci-run-missing" },
    ]);
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

  it.each([
    {
      name: "same-name successful",
      replacementName: "proof",
      status: "completed",
      conclusion: "success",
    },
    {
      name: "queued",
      replacementName: "proof",
      status: "queued",
      conclusion: null,
    },
    {
      name: "in-progress",
      replacementName: "proof",
      status: "in_progress",
      conclusion: null,
    },
    {
      name: "renamed",
      replacementName: "renamed proof",
      status: "completed",
      conclusion: "success",
    },
  ])(
    "does not revive a cancelled run superseded by a $name workflow run",
    async ({ replacementName, status, conclusion }) => {
      const generated = autoMergePr(40, "4".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { name: replacementName, status, conclusion }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100),
          200: cancelledRun(200, { conclusion }),
        },
      });

      await runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      });

      expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
    },
  );

  it("does not let a newer run from another workflow suppress a cancelled run", async () => {
    const generated = autoMergePr(41, "5".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success" }),
        ],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { workflow_id: 20, conclusion: "success" }),
      },
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
        args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
      },
    ]);
    expect(
      calls.filter((call) => call.method === "actions.getWorkflowRun" && call.args.run_id === 200),
    ).toHaveLength(1);
  });

  it.each([
    { name: "manual dispatch", replacement: { event: "workflow_dispatch" } },
    { name: "push event", replacement: { event: "push" } },
    { name: "different pull-request event", replacement: { event: "pull_request" } },
    { name: "different head branch", replacement: { head_branch: "automation/another-pr" } },
    { name: "missing head branch", replacement: { head_branch: null } },
    {
      name: "fork head repository",
      replacement: { head_repository: { full_name: "someone-else/openclaw" } },
    },
    { name: "missing head repository", replacement: { head_repository: undefined } },
    {
      name: "run predating the pull request",
      replacement: { created_at: new Date(NOW - 3 * HOURS).toISOString() },
    },
  ])(
    "does not let a newer $name from the same workflow suppress the PR run",
    async ({ replacement }) => {
      const generated = autoMergePr(48, "c".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { conclusion: "success" }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100),
          200: cancelledRun(200, { conclusion: "success", ...replacement }),
        },
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
          args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
        },
      ]);
      expect(
        calls.filter(
          (call) => call.method === "actions.getWorkflowRun" && call.args.run_id === 200,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    { name: "successful", status: "completed", conclusion: "success" },
    { name: "queued", status: "queued", conclusion: null },
    { name: "in-progress", status: "in_progress", conclusion: null },
  ])("does not report a $name replacement as a dry-run revive", async ({ status, conclusion }) => {
    const generated = autoMergePr(42, "6".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { status, conclusion }),
        ],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { conclusion }),
      },
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
    expect(logs.some((line) => line.includes("would revive cancelled run 100"))).toBe(false);
  });

  it("does not revive a run superseded during pre-mutation revalidation", async () => {
    const generated = autoMergePr(43, "7".repeat(40));
    const cancelled = githubActionsCheck(100);
    const replacement = githubActionsCheck(200, { conclusion: "success" });
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [[cancelled], [cancelled, replacement]],
      },
      workflowRunsById: {
        100: cancelledRun(100),
        200: cancelledRun(200, { conclusion: "success" }),
      },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "checks.listForRef")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it.each([
    { name: "cancelled run", cancelledWorkflowId: null, replacementWorkflowId: 10 },
    { name: "replacement run", cancelledWorkflowId: 10, replacementWorkflowId: null },
  ])(
    "does not revive when the $name has no verifiable workflow identity",
    async ({ cancelledWorkflowId, replacementWorkflowId }) => {
      const generated = autoMergePr(44, "8".repeat(40));
      const { github, calls } = fakeGithub({
        prs: [generated],
        runsBySha: {},
        checksByRef: {
          [generated.head.sha]: [
            githubActionsCheck(100),
            githubActionsCheck(200, { conclusion: "success" }),
          ],
        },
        workflowRunsById: {
          100: cancelledRun(100, { workflow_id: cancelledWorkflowId }),
          200: cancelledRun(200, {
            workflow_id: replacementWorkflowId,
            conclusion: "success",
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
    },
  );

  it.each([
    { name: "missing", detailsUrl: null },
    { name: "undefined", detailsUrl: undefined },
    { name: "malformed", detailsUrl: "https://github.com/openclaw/openclaw/actions/runs/nope" },
  ])("does not revive when an Actions replacement has a $name run URL", async ({ detailsUrl }) => {
    const generated = autoMergePr(46, "a".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success", details_url: detailsUrl }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
    });

    await runPrCiSweeper({
      github: github as never,
      context: context as never,
      core: core as never,
      now: NOW,
    });

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
  });

  it("does not let a malformed non-Actions check suppress a cancelled workflow", async () => {
    const generated = autoMergePr(47, "b".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, {
            app: { slug: "external-ci" },
            conclusion: "success",
            details_url: null,
          }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
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
        args: { owner: "openclaw", repo: "openclaw", run_id: 100 },
      },
    ]);
  });

  it("fails closed when replacement workflow metadata cannot be loaded", async () => {
    const generated = autoMergePr(45, "9".repeat(40));
    const { github, calls } = fakeGithub({
      prs: [generated],
      runsBySha: {},
      checksByRef: {
        [generated.head.sha]: [
          githubActionsCheck(100),
          githubActionsCheck(200, { conclusion: "success" }),
        ],
      },
      workflowRunsById: { 100: cancelledRun(100) },
      workflowRunErrorsById: { 200: new Error("replacement workflow unavailable") },
    });

    await expect(
      runPrCiSweeper({
        github: github as never,
        context: context as never,
        core: core as never,
        now: NOW,
      }),
    ).rejects.toThrow("replacement workflow unavailable");

    expect(calls.filter((call) => call.method === "actions.reRunWorkflow")).toEqual([]);
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
