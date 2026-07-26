import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadControlUiSessionPullRequests,
  parseControlUiSessionPullRequestsParams,
} from "./control-ui-session-prs.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

type GitContext = { owner: string; repo: string; branch: string };

function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
}

function routedFetch(
  routes: Array<{ match: string; response: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    return route.response();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

function pullListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 103469,
    title: "fix(macos): tighten the link-browser tab header",
    html_url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}

const context: GitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};

const resolveGitContext = async () => context;
let cacheEpochMs = Date.now();
let cacheEvictionEpoch = 0;

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

async function evictPullRequestCache(): Promise<void> {
  const epoch = (cacheEvictionEpoch += 1);
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:main" },
        {
          fetchImpl: async () => githubJson([]),
          resolveGitContext: async () => ({
            ...context,
            branch: `test/cache-eviction-${epoch}-${index}`,
          }),
        },
      ),
    ),
  );
}

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

describe("session branch diff stats", () => {
  const execFileAsync = promisify(execFile);
  let root: string;

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd: root,
    });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
    await evictPullRequestCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("counts committed and uncommitted changes vs the origin default merge base", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    // Stand in for the remote default branch without a real remote.
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.writeFile(path.join(root, "a.txt"), "one\nthree\n");
    await fs.writeFile(path.join(root, "b.txt"), "committed\n");
    await git("add", "a.txt", "b.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    // Uncommitted work counts too: the row sizes the PR the push would open.
    await fs.appendFile(path.join(root, "b.txt"), "pending\n");
    // Untracked files count toward additions as well.
    await fs.writeFile(path.join(root, "c.txt"), "brand new\n");

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 4,
      deletions: 1,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("skips non-regular and binary untracked files without blocking", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    await fs.writeFile(path.join(root, "text.txt"), "alpha\nbeta\n");
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0x50, 0x00, 0x4b, 0x03]));
    if (process.platform !== "win32") {
      // A named pipe must not block the stats path until the git timeout.
      await execFileAsync("mkfifo", [path.join(root, "pipe")]);
    }

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // 1 committed line + 2 untracked text lines; binary and pipe count 0.
    expect(result.branch).toMatchObject({ additions: 3, deletions: 0 });
  });

  it("omits the branch payload when the remote branch has nothing to compare", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // origin/feature == origin/main: GitHub would answer "nothing to compare".
    expect(result.branch).toBeUndefined();
  });

  it("reports local changes without createUrl until the branch exists on origin", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "local only");

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // GitHub's pull/new page 404s for unpushed branches, so no Create PR
    // link — but the session's changed files still get a row.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("reports uncommitted changes when the remote branch has nothing to compare", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    await fs.appendFile(path.join(root, "a.txt"), "pending\n");

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // origin/feature == origin/main, so no Create PR link yet, but the dirty
    // working tree is visible work the row must surface.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("drops the Create PR row once the pushed tip is a merged PR's head", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "refs/remotes/origin/feature")).stdout.trim();

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    expect(result.pullRequests[0]?.state).toBe("merged");
    // A squash merge keeps origin/feature "ahead" of origin/main forever, but
    // the landed tip must not resurrect a Create PR invitation to duplicate it.
    expect(result.branch).toBeUndefined();
  });

  it("sizes only post-merge work, without a create link, once the PR landed", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "refs/remotes/origin/feature")).stdout.trim();
    await fs.appendFile(path.join(root, "a.txt"), "follow-up\n");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The stale merge base would replay the merged +1 as pending; only the
    // uncommitted follow-up line counts, and no Create PR link is offered.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps the Create PR row when the PR merged into a non-default base", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "refs/remotes/origin/feature")).stdout.trim();

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
              base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // Merging into release does not land the work on main; the affordance to
    // open a PR against the default branch must survive.
    expect(result.branch?.createUrl).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("suppresses the row via local HEAD when the merged remote ref was pruned", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    // No origin/feature ref: GitHub deleted the head branch on merge and a
    // pruned fetch removed the remote-tracking ref.
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // Without this, the stale merge base replays the landed diff forever.
    expect(result.branch).toBeUndefined();
  });

  it("suppresses the row when the local checkout trails the merged remote tip", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    const staleHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // Another checkout pushed a final commit before the merge; this session's
    // HEAD trails the merged remote tip.
    await fs.appendFile(path.join(root, "a.txt"), "review fix\n");
    await git("add", "a.txt");
    await git("commit", "-m", "review fix");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("reset", "--hard", staleHead);

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // Everything committed here is contained in the merge; a clean tree gets
    // no row, and the stale merge base must not replay the landed subset.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR for a branch rebased past the landing with new work", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // Squash-land on main, then reuse the branch: reset onto updated main,
    // add new work, force-push.
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "squash land");
    const mergeCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");
    await fs.writeFile(path.join(root, "b.txt"), "second round\n");
    await git("add", "b.txt");
    await git("commit", "-m", "second PR work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
              merge_commit_sha: mergeCommit,
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The merge base contains the PR's merge commit, proving the rebase went
    // past the landing: the new commit is a genuine second PR.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("counts a release-branch landing once its merge commit reaches main", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // The PR merged into a release branch whose squash later reached main.
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "release merge propagated");
    const mergeCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
              merge_commit_sha: mergeCommit,
              base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The release landing propagated to main, so the branch is landed work;
    // no Create PR row despite the non-default PR base.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR atop a merge-commit landing without a rebase", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // A merge-commit landing keeps the head an ancestor of main.
    await git("checkout", "main");
    await git("merge", "--no-ff", "feature", "-m", "merge PR");
    const mergeCommit = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");
    await fs.writeFile(path.join(root, "b.txt"), "follow-up\n");
    await git("add", "b.txt");
    await git("commit", "-m", "follow-up work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
              merge_commit_sha: mergeCommit,
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The merged head is contained in the merge base, so a new PR's compare
    // holds only the follow-up commit; no rebase is required here.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("keeps Create PR off while a newer squash landing is unincorporated", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    // PR1: squash-land, then the branch rebases past it.
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "pr1 work");
    const pr1Head = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "squash pr1");
    const pr1Merge = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "feature");
    await git("reset", "--hard", "main");
    // PR2 on the rebased branch: squash-lands on main, but the branch does
    // not rebase again before the follow-up commit.
    await fs.writeFile(path.join(root, "b.txt"), "pr2\n");
    await git("add", "b.txt");
    await git("commit", "-m", "pr2 work");
    const pr2Head = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "main");
    await fs.writeFile(path.join(root, "b.txt"), "pr2\n");
    await git("add", "b.txt");
    await git("commit", "-m", "squash pr2");
    const pr2Merge = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");
    await fs.writeFile(path.join(root, "c.txt"), "follow-up\n");
    await git("add", "c.txt");
    await git("commit", "-m", "follow-up work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              number: 2,
              state: "closed",
              merged_at: "2026-07-02T00:00:00Z",
              head: { sha: pr2Head },
              merge_commit_sha: pr2Merge,
            }),
            pullListItem({
              number: 1,
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: pr1Head },
              merge_commit_sha: pr1Merge,
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // PR1's landing is in the merge base but PR2's is not: a new PR would
    // replay PR2's diff, so only the follow-up shows and the link stays off.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("offers no Create PR from a stale tracking ref behind the merged head", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    const staleSha = (await git("rev-parse", "HEAD")).stdout.trim();
    await fs.appendFile(path.join(root, "a.txt"), "final fix\n");
    await git("add", "a.txt");
    await git("commit", "-m", "final fix");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // Another clone pushed the final commit and merged; this checkout's
    // tracking ref and HEAD still sit at the earlier commit.
    await git("update-ref", "refs/remotes/origin/feature", staleSha);
    await git("reset", "--hard", staleSha);

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The stale ref is not proof of new pushed work; everything here is
    // contained in the merged head, so no row and no Create PR invitation.
    expect(result.branch).toBeUndefined();
  });

  it("prefers the newer merge base after the default branch was merged back in", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // Squash-land on main, main moves on, then the session merges main back
    // into the still-checked-out feature branch.
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "squash land");
    await fs.writeFile(path.join(root, "b.txt"), "unrelated\n");
    await git("add", "b.txt");
    await git("commit", "-m", "unrelated main work");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");
    await git("merge", "refs/remotes/origin/main", "-m", "merge main");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The merge base (main's tip) already carries the landed content; sizing
    // against the older merged head would replay main's progress as pending.
    expect(result.branch).toBeUndefined();
  });

  it("ignores the merged tip as a diff base when the branch was reset onto main", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "HEAD")).stdout.trim();
    // Squash-land the same content on main, then main moves on.
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "squash land");
    await fs.writeFile(path.join(root, "b.txt"), "unrelated\n");
    await git("add", "b.txt");
    await git("commit", "-m", "unrelated main work");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    // The session resets its branch onto updated main; origin/feature still
    // points at the merged head.
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // Diffing against the stale merged tip would report main's unrelated
    // progress as pending feature work; the merge-base path reports nothing.
    expect(result.branch).toBeUndefined();
  });

  it("keeps post-merge commits as a stats-only row until the branch rebases", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = (await git("rev-parse", "refs/remotes/origin/feature")).stdout.trim();
    await fs.appendFile(path.join(root, "a.txt"), "three\n");
    await git("add", "a.txt");
    await git("commit", "-m", "post-merge work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              state: "closed",
              merged_at: "2026-07-01T00:00:00Z",
              head: { sha: mergedHead },
            }),
          ]),
      },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          defaultBranch: "main",
        }),
      },
    );

    // The post-merge commit counts (not the landed diff), but GitHub's
    // compare for this un-rebased tip would replay the landed changes, so the
    // Create PR link stays off until the branch incorporates the landing.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("omits the branch payload when the default branch is unknown", async () => {
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    const result = await loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl,
        // No defaultBranch: origin/HEAD unresolvable in this checkout.
        resolveGitContext: async () => ({ ...context, branch: "feature", root }),
      },
    );

    // Fail closed: without a default branch there is nothing to compare against.
    expect(result.branch).toBeUndefined();
  });
});
