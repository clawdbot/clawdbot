import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadControlUiSessionPullRequests,
  parseControlUiSessionPullRequestsParams,
} from "./control-ui-session-prs.js";
import {
  evictPullRequestCache,
  githubJson,
  pullListItem,
  requestUrl,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

const resolveGitContext = async () => context;
let cacheEpochMs = Date.now();

describe("parseGitHubRemoteUrl", () => {
  it("parses https, scp-like, and ssh remotes", () => {
    const expected = { owner: "openclaw", repo: "openclaw" };
    expect(parseGitHubRemoteUrl("https://github.com/openclaw/openclaw.git")).toEqual(expected);
    expect(parseGitHubRemoteUrl("https://github.com/openclaw/openclaw")).toEqual(expected);
    expect(parseGitHubRemoteUrl("git@github.com:openclaw/openclaw.git")).toEqual(expected);
    expect(parseGitHubRemoteUrl("ssh://git@github.com/openclaw/openclaw.git")).toEqual(expected);
  });

  it("rejects non-GitHub and malformed remotes", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/openclaw/openclaw.git")).toBeNull();
    expect(parseGitHubRemoteUrl("git@github.com:openclaw")).toBeNull();
    expect(parseGitHubRemoteUrl("https://github.com/openclaw/openclaw/extra")).toBeNull();
    expect(parseGitHubRemoteUrl("/local/path/repo.git")).toBeNull();
  });
});

describe("parseControlUiSessionPullRequestsParams", () => {
  it("requires a non-empty session key", () => {
    expect(parseControlUiSessionPullRequestsParams({ sessionKey: "agent:main:main" })).toEqual({
      sessionKey: "agent:main:main",
    });
    expect(parseControlUiSessionPullRequestsParams({ sessionKey: "  " })).toBeNull();
    expect(parseControlUiSessionPullRequestsParams("agent:main:main")).toBeNull();
    expect(parseControlUiSessionPullRequestsParams({})).toBeNull();
  });

  it("keeps the UI's scoped agent id for global-alias session keys", () => {
    expect(
      parseControlUiSessionPullRequestsParams({ sessionKey: "global", agentId: "work" }),
    ).toEqual({ sessionKey: "global", agentId: "work" });
    expect(parseControlUiSessionPullRequestsParams({ sessionKey: "global", agentId: " " })).toEqual(
      { sessionKey: "global" },
    );
  });

  it("accepts only an explicit refresh request", () => {
    expect(
      parseControlUiSessionPullRequestsParams({
        sessionKey: "agent:main:main",
        refresh: true,
      }),
    ).toEqual({ sessionKey: "agent:main:main", refresh: true });
    expect(
      parseControlUiSessionPullRequestsParams({
        sessionKey: "agent:main:main",
        refresh: false,
      }),
    ).toEqual({ sessionKey: "agent:main:main" });
  });
});

describe("loadControlUiSessionPullRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cacheEpochMs += 10 * 60_000;
    vi.setSystemTime(cacheEpochMs);
  });

  afterEach(async () => {
    await evictPullRequestCache();
    vi.useRealTimers();
  });

  it("returns chips with diff counts and check rollup for open PRs", async () => {
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      {
        match: "/pulls/103469",
        response: () => githubJson({ additions: 4, deletions: 3 }),
      },
      {
        match: "/check-runs",
        response: () =>
          githubJson({
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "skipped" },
            ],
          }),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result).toEqual({
      pullRequests: [
        {
          number: 103469,
          owner: "openclaw",
          repo: "openclaw",
          branch: context.branch,
          title: "fix(macos): tighten the link-browser tab header",
          url: "https://github.com/openclaw/openclaw/pull/103469",
          state: "open",
          additions: 4,
          deletions: 3,
          checks: { state: "passing", passed: 1, failed: 0, skipped: 1, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        },
      ],
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch: context.branch,
        createUrl:
          "https://github.com/openclaw/openclaw/pull/new/claude/browser-tabs-tighter-header",
      },
      rateLimited: false,
    });
  });

  it("skips diff and check fetches for merged PRs", async () => {
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result.pullRequests).toEqual([
      {
        number: 103469,
        owner: "openclaw",
        repo: "openclaw",
        branch: context.branch,
        title: "fix(macos): tighten the link-browser tab header",
        url: "https://github.com/openclaw/openclaw/pull/103469",
        state: "merged",
      },
    ]);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("marks in-flight checks pending and failed conclusions failing", async () => {
    const checkRuns = [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
    ];
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      { match: "/pulls/103469", response: () => githubJson({ additions: 1, deletions: 1 }) },
      { match: "/check-runs", response: () => githubJson({ check_runs: checkRuns }) },
    ]);

    const pending = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(pending.pullRequests[0]?.checks).toEqual({
      state: "pending",
      passed: 1,
      failed: 0,
      skipped: 0,
      running: 1,
    });

    vi.advanceTimersByTime(10 * 60_000);
    checkRuns[0] = { status: "completed", conclusion: "timed_out" };
    const failing = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(failing.pullRequests[0]?.checks).toEqual({
      state: "failing",
      passed: 1,
      failed: 1,
      skipped: 0,
      running: 0,
    });

    // A stale conclusion means GitHub invalidated the run; it must not be
    // rolled up as green.
    vi.advanceTimersByTime(10 * 60_000);
    checkRuns[0] = { status: "completed", conclusion: "stale" };
    const stale = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stale.pullRequests[0]?.checks).toEqual({
      state: "pending",
      passed: 1,
      failed: 0,
      skipped: 0,
      running: 1,
    });
  });

  it("falls back to the fork parent repo when the origin repo has no PRs", async () => {
    const fetchImpl = routedFetch([
      {
        match: "/repos/fork-owner/openclaw/pulls?head=",
        response: () => githubJson([]),
      },
      {
        match: "/repos/fork-owner/openclaw",
        response: () =>
          githubJson({
            fork: true,
            parent: { name: "openclaw", owner: { login: "openclaw" } },
          }),
      },
      {
        match: "/repos/openclaw/openclaw/pulls?head=",
        response: () => githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({ ...context, owner: "fork-owner" }),
      },
    );

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(
      fetchImpl.mock.calls.some((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes(
          "head=fork-owner%3Aclaude%2Fbrowser-tabs-tighter-header",
        ),
      ),
    ).toBe(true);
  });

  it("serves stale chips flagged rateLimited when GitHub quota runs out", async () => {
    let limited = false;
    const rateLimitedResponse = () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
      });
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          limited
            ? rateLimitedResponse()
            : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);

    const fresh = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(fresh.rateLimited).toBe(false);

    limited = true;
    vi.advanceTimersByTime(61_000);
    const stale = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stale.rateLimited).toBe(true);
    expect(stale.pullRequests).toEqual(fresh.pullRequests);

    const callsDuringBackoff = fetchImpl.mock.calls.length;
    const explicitRefresh = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    expect(explicitRefresh).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);

    vi.advanceTimersByTime(61_000);
    const stillBackedOff = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stillBackedOff).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);
  });

  it("degrades permission 403s on optional fetches to chips without checks", async () => {
    // A bare 403 (fine-grained token without checks read) is not a rate
    // limit; the chip must render without CI instead of aborting the row.
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      { match: "/pulls/103469", response: () => githubJson({ additions: 4, deletions: 3 }) },
      {
        match: "/check-runs",
        response: () => githubJson({ message: "Resource not accessible by integration" }, 403),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result.rateLimited).toBe(false);
    expect(result.pullRequests[0]).toMatchObject({ number: 103469, additions: 4, deletions: 3 });
    expect(result.pullRequests[0]?.checks).toBeUndefined();
  });

  it("returns no chips without a git context and spends no quota", async () => {
    const fetchImpl = routedFetch([]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext: async () => null },
    );
    expect(result).toEqual({ pullRequests: [], rateLimited: false });
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("refreshes a cached empty result after the assistant creates a PR", async () => {
    let pulls: Record<string, unknown>[] = [];
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson(pulls) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);

    const initial = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(initial.pullRequests).toEqual([]);

    pulls = [pullListItem({ merged_at: "2026-07-09T10:00:00Z" })];
    const cached = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(cached.pullRequests).toEqual([]);

    const forcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    const ordinaryFollower = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    const duplicateForcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    const refreshed = await Promise.all([forcedRefresh, ordinaryFollower, duplicateForcedRefresh]);
    expect(refreshed.map((result) => result.pullRequests.map((item) => item.number))).toEqual([
      [103469],
      [103469],
      [103469],
    ]);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes("/pulls?head="),
      ),
    ).toHaveLength(2);
  });

  it("queues one forced refresh behind an ordinary in-flight lookup", async () => {
    let resolveInitialPulls!: (response: Response) => void;
    let signalInitialPullStarted!: () => void;
    const initialPulls = new Promise<Response>((resolve) => {
      resolveInitialPulls = resolve;
    });
    const initialPullStarted = new Promise<void>((resolve) => {
      signalInitialPullStarted = resolve;
    });
    let pullListCalls = 0;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => {
          pullListCalls += 1;
          if (pullListCalls === 1) {
            signalInitialPullStarted();
            return initialPulls;
          }
          return githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]);
        },
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);

    const initial = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    await initialPullStarted;
    const forcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );
    await Promise.resolve();
    const ordinaryFollower = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    const duplicateForcedRefresh = loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main", refresh: true },
      { fetchImpl, resolveGitContext },
    );

    resolveInitialPulls(githubJson([]));
    expect((await initial).pullRequests).toEqual([]);
    expect(
      (await Promise.all([forcedRefresh, ordinaryFollower, duplicateForcedRefresh])).map((result) =>
        result.pullRequests.map((item) => item.number),
      ),
    ).toEqual([[103469], [103469], [103469]]);
    expect(pullListCalls).toBe(2);
  });

  it("keeps branch metadata when the very first GitHub fetch is rate limited", async () => {
    // The pre-PR row's rate-limit warning depends on this: with no cached
    // chips, the local-git branch payload is all the UI has left to render.
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          new Response(JSON.stringify({ message: "rate limited" }), {
            status: 403,
            headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
          }),
      },
    ]);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result).toEqual({
      pullRequests: [],
      branch: {
        owner: "openclaw",
        repo: "openclaw",
        branch: context.branch,
        createUrl:
          "https://github.com/openclaw/openclaw/pull/new/claude/browser-tabs-tighter-header",
      },
      rateLimited: true,
    });
  });

  it("keeps the proven PR list as state-only chips when detail fetches are rate limited", async () => {
    // Cold cache: the pulls list succeeds, then quota dies on the per-PR
    // detail fetch. The open PR must survive so the UI does not offer a
    // duplicate Create PR row.
    const rateLimitedResponse = () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "x-ratelimit-remaining": "0" },
      });
    const routes = [
      { match: "/pulls?head=", response: () => githubJson([pullListItem()]) },
      { match: "/pulls/103469", response: rateLimitedResponse },
      { match: "/check-runs", response: rateLimitedResponse },
    ];
    const fetchImpl = routedFetch(routes);

    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );

    expect(result.rateLimited).toBe(true);
    expect(result.pullRequests).toEqual([
      {
        number: 103469,
        owner: "openclaw",
        repo: "openclaw",
        branch: context.branch,
        title: "fix(macos): tighten the link-browser tab header",
        url: "https://github.com/openclaw/openclaw/pull/103469",
        state: "open",
      },
    ]);

    // Outage outlives the rate-limit cache window and now even the list
    // fetch 429s: the proven chips must survive as the last-known fallback.
    routes.length = 0;
    routes.push({ match: "/pulls?head=", response: rateLimitedResponse });
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    const stillLimited = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      { fetchImpl, resolveGitContext },
    );
    expect(stillLimited.rateLimited).toBe(true);
    expect(stillLimited.pullRequests.map((item) => item.number)).toEqual([103469]);
  });

  it("escapes create-PR URL segments while keeping branch slashes", async () => {
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      // Empty PR lists trigger the fork-parent probe; answer "not a fork".
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({ ...context, branch: "claude/fix #1" }),
      },
    );
    expect(result.branch?.createUrl).toBe(
      "https://github.com/openclaw/openclaw/pull/new/claude/fix%20%231",
    );
  });
});
