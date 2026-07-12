import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadControlUiSessionPullRequests,
  parseControlUiSessionPullRequestsParams,
  parseGitHubRemoteUrl,
  resetControlUiSessionPullRequestCacheForTests,
  type SessionPullRequestGitContext,
} from "./control-ui-session-prs.js";

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

function routedFetch(routes: Array<{ match: string; response: () => Response }>) {
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
    base: { repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}

const context: SessionPullRequestGitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};

const resolveGitContext = async () => context;

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
});

describe("loadControlUiSessionPullRequests", () => {
  beforeEach(() => {
    resetControlUiSessionPullRequestCacheForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
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

    resetControlUiSessionPullRequestCacheForTests();
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
    resetControlUiSessionPullRequestCacheForTests();
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
    resetControlUiSessionPullRequestCacheForTests();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
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

  it("omits the branch payload until the branch exists on origin", async () => {
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

    // GitHub's pull/new page 404s for unpushed branches, so no Create PR row.
    expect(result.branch).toBeUndefined();
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
