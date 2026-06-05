// Dependency Guard Script tests cover dependency guard script script behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ERROR_BODY_MAX_BYTES,
  canAutoscrubPullRequest,
  createAutoscrubCommit,
  dependencyGuardCommentAuthors,
  dependencyGuardCommentHeadSha,
  dependencyGuardTrustedActorCandidates,
  dependencyFieldChanges,
  dependencyOverrideExpectedSha,
  findDependencyOverrideCommand,
  findDependencyOverrideCommandAsync,
  findTrustedDependencyGuardActor,
  githubApi,
  isAutoscrubbedDependencyComment,
  isDependencyGuardAuthorizedForHead,
  isDependencyFile,
  isDependencyGuardMarkerComment,
  isDependencyManifest,
  isDependencyGuardTrustedForHead,
  isPackageLockfile,
  readBoundedGitHubErrorText,
  renderAuthorizedDependencyComment,
  renderAutoscrubbedDependencyComment,
  renderBlockedDependencyComment,
  renderClearedDependencyGuardComment,
  renderTrustedDependencyComment,
  sanitizeDisplayValue,
  securityApproverSet,
  shouldAutoscrubDependencyLockfiles,
} from "../../scripts/github/dependency-guard.mjs";

const headSha = "a".repeat(40);
const staleSha = "b".repeat(40);

describe("dependency guard script", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects dependency guard file surfaces", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("package.json")).toBe(false);
    expect(isDependencyFile("ui/package.json")).toBe(false);
    expect(isDependencyFile("packages/core/package.json")).toBe(false);
    expect(isDependencyFile("qa/convex-credential-broker/package.json")).toBe(false);
    expect(isDependencyFile("extensions/slack/npm-shrinkwrap.json")).toBe(true);
    expect(isDependencyFile("tools/nested/pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("src/index.ts")).toBe(false);
    expect(isPackageLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isPackageLockfile("extensions/slack/npm-shrinkwrap.json")).toBe(true);
    expect(isPackageLockfile("package.json")).toBe(false);
  });

  it("compares package manifest fields that can affect dependency resolution", () => {
    expect(isDependencyManifest("package.json")).toBe(true);
    expect(isDependencyManifest("extensions/slack/package.json")).toBe(true);
    expect(isDependencyManifest("qa/convex-credential-broker/package.json")).toBe(true);
    expect(isDependencyManifest("src/index.ts")).toBe(false);
    expect(
      dependencyFieldChanges(
        { scripts: { test: "old" }, dependencies: { a: "1" } },
        { scripts: { test: "new" }, dependencies: { a: "1" } },
      ),
    ).toEqual([]);
    expect(
      dependencyFieldChanges(
        { dependencies: { a: "1" }, devDependencies: { b: "1" } },
        { dependencies: { a: "2" }, devDependencies: { b: "1", c: "1" } },
      ),
    ).toEqual(["dependencies", "devDependencies"]);
    expect(
      dependencyFieldChanges(
        {
          optionalDependencies: { a: "1" },
          peerDependencies: { b: "1" },
          overrides: { c: "1" },
          packageManager: "pnpm@10.0.0",
          pnpm: { patchedDependencies: { d: "patches/d.patch" } },
          scripts: { test: "old" },
        },
        {
          optionalDependencies: { a: "2" },
          peerDependencies: { b: "2" },
          overrides: { c: "2" },
          packageManager: "pnpm@10.1.0",
          pnpm: { patchedDependencies: { d: "patches/d2.patch" } },
          scripts: { test: "new" },
        },
      ),
    ).toEqual(["optionalDependencies", "peerDependencies", "overrides", "packageManager", "pnpm"]);
  });

  it("accepts only security-member override commands for the current head sha", () => {
    const comments = [
      {
        body: "/allow-dependencies-change not enough",
        created_at: "2026-05-28T20:00:00Z",
        user: { login: "not-security" },
      },
      {
        body: "/allow-dependencies-change stale approval",
        created_at: "2026-05-28T20:01:00Z",
        user: { login: "security-user" },
      },
      {
        body: "/allow-dependencies-change reviewed dependency graph",
        created_at: "2026-05-28T20:03:00Z",
        html_url: "https://example.test/comment",
        user: { login: "security-user" },
      },
    ];

    const override = findDependencyOverrideCommand({
      comments,
      expectedSha: headSha,
      isSecurityMember: (login) => login === "security-user",
      newerThan: "2026-05-28T20:02:00Z",
    });

    expect(override).toEqual({
      login: "security-user",
      reason: "reviewed dependency graph",
      sha: headSha,
      url: "https://example.test/comment",
    });
  });

  it("rejects stale or non-security override commands", async () => {
    const comments = [
      {
        body: "/allow-dependencies-change stale approval",
        created_at: "2026-05-28T20:00:00Z",
        user: { login: "security-user" },
      },
      {
        body: "/allow-dependencies-change not enough",
        created_at: "2026-05-28T20:02:00Z",
        user: { login: "not-security" },
      },
    ];

    await expect(
      findDependencyOverrideCommandAsync({
        comments,
        expectedSha: headSha,
        isSecurityMember: async (login) => login === "security-user",
        newerThan: "2026-05-28T20:01:00Z",
      }),
    ).resolves.toBeNull();
  });

  it("accepts repository admins through the same sha-bound override command", async () => {
    const comments = [
      {
        body: "/allow-dependencies-change admin reviewed",
        created_at: "2026-05-28T20:03:00Z",
        html_url: "https://example.test/comment",
        user: { login: "repo-admin" },
      },
    ];

    await expect(
      findDependencyOverrideCommandAsync({
        comments,
        expectedSha: headSha,
        isSecurityMember: async (login) => login === "repo-admin",
        newerThan: "2026-05-28T20:02:00Z",
      }),
    ).resolves.toEqual({
      login: "repo-admin",
      reason: "admin reviewed",
      sha: headSha,
      url: "https://example.test/comment",
    });
  });

  it("recognizes trusted dependency guard actors automatically", async () => {
    const sameActorCandidates = dependencyGuardTrustedActorCandidates({
      pullRequest: { user: { login: "repo-admin" } },
      event: { pull_request: { head: { sha: headSha } }, sender: { login: "repo-admin" } },
      currentHeadSha: headSha,
    });
    const untrustedAuthorCandidate = dependencyGuardTrustedActorCandidates({
      pullRequest: { user: { login: "contributor" } },
      event: { after: headSha, sender: { login: "security-user" } },
      currentHeadSha: headSha,
    });
    const staleAuthorCandidate = dependencyGuardTrustedActorCandidates({
      pullRequest: { user: { login: "repo-admin" } },
      event: { pull_request: { head: { sha: staleSha } }, sender: { login: "repo-admin" } },
      currentHeadSha: headSha,
    });

    expect(sameActorCandidates).toEqual([{ login: "repo-admin", source: "pull request author" }]);
    expect(untrustedAuthorCandidate).toEqual([
      { login: "contributor", source: "pull request author" },
    ]);
    expect(staleAuthorCandidate).toEqual([]);

    await expect(
      findTrustedDependencyGuardActor({
        candidates: untrustedAuthorCandidate,
        isDependencyApprover: async (login) =>
          login === "security-user" || login === "repo-admin" ? "openclaw-secops" : null,
      }),
    ).resolves.toBeNull();
    await expect(
      findTrustedDependencyGuardActor({
        candidates: sameActorCandidates,
        isDependencyApprover: async (login) => (login === "repo-admin" ? "repository admin" : null),
      }),
    ).resolves.toEqual({
      login: "repo-admin",
      reason: "pull request author; repository admin",
    });
  });

  it("renders trusted dependency graph comments without blocker language", () => {
    const body = renderTrustedDependencyComment({
      actor: { login: "repo-admin", reason: "pull request author; repository admin" },
      headSha,
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency graph changes noted");
    expect(body).toContain("informational");
    expect(body).toContain("@repo-admin");
    expect(body).toContain(headSha);
    expect(body).not.toContain("are blocked");
    expect(body).not.toContain("/allow-dependencies-change");
    expect(isDependencyGuardTrustedForHead({ body }, headSha)).toBe(true);
    expect(isDependencyGuardTrustedForHead({ body }, staleSha)).toBe(false);
  });

  it("rejects override commands without a freshness barrier", () => {
    const override = findDependencyOverrideCommand({
      comments: [
        {
          body: "/allow-dependencies-change",
          created_at: "2026-05-28T20:03:00Z",
          user: { login: "security-user" },
        },
      ],
      expectedSha: headSha,
      isSecurityMember: (login) => login === "security-user",
    });

    expect(override).toBeNull();
  });

  it("accepts override commands without a reason", () => {
    const override = findDependencyOverrideCommand({
      comments: [
        {
          body: "/allow-dependencies-change",
          created_at: "2026-05-28T20:03:00Z",
          user: { login: "security-user" },
        },
      ],
      expectedSha: headSha,
      isSecurityMember: (login) => login === "security-user",
      newerThan: "2026-05-28T20:02:00Z",
    });

    expect(override).toEqual({
      login: "security-user",
      reason: null,
      sha: headSha,
      url: undefined,
    });
  });

  it("binds override commands to the head sha in the blocked guard comment", () => {
    const blockedComment = {
      body: renderBlockedDependencyComment({
        baseBranch: "main",
        headSha,
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    };
    const staleBlockedComment = {
      body: renderBlockedDependencyComment({
        baseBranch: "main",
        headSha: staleSha,
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    };

    expect(dependencyGuardCommentHeadSha(blockedComment)).toBe(headSha);
    expect(dependencyOverrideExpectedSha(blockedComment, headSha)).toBe(headSha);
    expect(dependencyOverrideExpectedSha(staleBlockedComment, headSha)).toBeNull();
  });

  it("preserves same-head authorization across reruns", () => {
    const authorizedComment = {
      body: renderAuthorizedDependencyComment({
        login: "security-user",
        reason: null,
        sha: headSha,
      }),
    };

    expect(dependencyGuardCommentHeadSha(authorizedComment)).toBe(headSha);
    expect(isDependencyGuardAuthorizedForHead(authorizedComment, headSha)).toBe(true);
    expect(isDependencyGuardAuthorizedForHead(authorizedComment, staleSha)).toBe(false);
    expect(dependencyOverrideExpectedSha(authorizedComment, headSha)).toBeNull();
  });

  it("trusts only configured dependency guard marker comment authors", () => {
    const trustedAuthors = dependencyGuardCommentAuthors(
      "github-actions[bot], openclaw-autoscrub[bot]",
    );

    expect(
      isDependencyGuardMarkerComment(
        {
          body: "<!-- openclaw:dependency-graph-guard -->",
          user: { login: "openclaw-autoscrub[bot]" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(true);
    expect(
      isDependencyGuardMarkerComment(
        {
          body: "<!-- openclaw:dependency-graph-guard -->",
          user: { login: "contributor" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(false);
    expect(
      isDependencyGuardMarkerComment(
        {
          body: "no marker",
          user: { login: "github-actions[bot]" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(false);
  });

  it("renders deterministic removal guidance for blocked lockfile changes", () => {
    const body = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml", "extensions/slack/npm-shrinkwrap.json"],
      dependencyManifestChanges: [
        {
          path: "package.json",
          fields: ["dependencies"],
        },
      ],
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency graph changes are blocked");
    expect(body).toContain("`pnpm-lock.yaml` changed.");
    expect(body).toContain("`extensions/slack/npm-shrinkwrap.json` changed.");
    expect(body).toContain("`package.json` changed `dependencies`.");
    expect(body).toContain(
      "git checkout 'origin/main' -- 'pnpm-lock.yaml' 'extensions/slack/npm-shrinkwrap.json'",
    );
    expect(body).toContain("/allow-dependencies-change");
    expect(body).toContain(`current head SHA (\`${headSha}\`)`);
    expect(body).toContain("A later push requires a fresh approval.");
  });

  it("shell-quotes PR-controlled paths in removal guidance", () => {
    const body = renderBlockedDependencyComment({
      baseBranch: "release/canary branch",
      headSha,
      lockfileChanges: [
        "dir with spaces/pnpm-lock.yaml",
        "safe/quote'$(touch bad);/package-lock.json",
      ],
      dependencyManifestChanges: [],
    });

    expect(body).toContain(
      "git checkout 'origin/release/canary branch' -- 'dir with spaces/pnpm-lock.yaml' 'safe/quote'\\''$(touch bad);/package-lock.json'",
    );
  });

  it("autoscrubs only lockfile changes with no dependency manifest changes", () => {
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(true);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [{ path: "package.json", fields: ["dependencies"] }],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: [],
        lockfileChanges: [],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml", "patches/example.patch"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
  });

  it("attempts autoscrub on PR branches maintainers can modify", () => {
    const sameRepoPullRequest = {
      head: {
        ref: "contributor/change",
        repo: { full_name: "openclaw/openclaw" },
        sha: headSha,
      },
    };
    const forkPullRequest = {
      head: {
        ref: "contributor/change",
        repo: { full_name: "external/openclaw" },
        sha: headSha,
      },
    };
    const editableForkPullRequest = {
      maintainer_can_modify: true,
      head: {
        ref: "contributor/change",
        repo: { full_name: "external/openclaw" },
        sha: headSha,
      },
    };

    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: sameRepoPullRequest,
      }),
    ).toBe(true);
    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: forkPullRequest,
      }),
    ).toBe(false);
    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: editableForkPullRequest,
      }),
    ).toBe(true);
  });

  it("renders deterministic autoscrub success comments", () => {
    const body = renderAutoscrubbedDependencyComment({
      baseBranch: "main",
      commitSha: staleSha,
      lockfileChanges: ["pnpm-lock.yaml", "extensions/slack/npm-shrinkwrap.json"],
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency lockfile changes were removed");
    expect(body).toContain("did not change dependency graph fields in package manifests");
    expect(body).toContain("`pnpm-lock.yaml`");
    expect(body).toContain("`extensions/slack/npm-shrinkwrap.json`");
    expect(body).toContain(`Cleanup commit: \`${staleSha}\``);
    expect(body).toContain(
      "restored each listed lockfile from the target branch and pushed the cleanup commit to this PR head",
    );
    expect(body).toContain(
      "this PR no longer carries those package lockfile diffs after the cleanup commit",
    );
    expect(isAutoscrubbedDependencyComment({ body })).toBe(true);
  });

  it("renders fork and dependency-manifest autoscrub guidance", () => {
    const forkBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: { kind: "not-attempted" },
    });
    const unsafeBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: {
        kind: "blocked-by-dependency-manifest-fields",
        changes: [{ path: "package.json", fields: ["dependencies"] }],
      },
    });
    const mixedBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: {
        kind: "blocked-by-other-dependency-files",
        files: ["patches/example.patch", "pnpm-workspace.yaml"],
      },
    });

    expect(forkBody).toContain("Auto-scrub was not attempted");
    expect(forkBody).toContain(
      "only push deterministic cleanup commits to PR branches that maintainers can modify",
    );
    expect(unsafeBody).toContain("changes package manifest dependency graph fields");
    expect(unsafeBody).toContain("`package.json` changed `dependencies`");
    expect(unsafeBody).toContain("Dependency graph changes must be reviewed by security");
    expect(mixedBody).toContain("also changes dependency-related files");
    expect(mixedBody).toContain("`patches/example.patch`");
    expect(mixedBody).toContain("`pnpm-workspace.yaml`");
  });

  it("reads base lockfiles with the base API before writing autoscrub commits", async () => {
    const calls: Array<{ api: string; path: string; variables?: unknown }> = [];
    const baseApi = {
      request: async (path: string) => {
        calls.push({ api: "base", path });
        if (path.includes("/contents/pnpm-lock.yaml?")) {
          return {
            content: Buffer.from("base lockfile").toString("base64"),
            encoding: "base64",
            sha: "base-file",
            type: "file",
          };
        }
        throw new Error(`unexpected base request: ${path}`);
      },
    };
    const writeApi = {
      graphql: async (_query: string, variables: unknown) => {
        calls.push({ api: "write", path: "graphql", variables });
        return { createCommitOnBranch: { commit: { oid: staleSha } } };
      },
    };

    const commit = await createAutoscrubCommit(
      { baseApi, writeApi },
      {
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: {
          base: { sha: "base-sha" },
          head: { ref: "contributor/change", sha: headSha },
        },
        lockfileChanges: ["pnpm-lock.yaml"],
        targetRepository: { owner: "contributor", repo: "openclaw" },
      },
    );

    expect(commit).toEqual({ sha: staleSha });
    expect(calls.map((call) => `${call.api}:${call.path}`)).toEqual([
      "base:/repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=base-sha",
      "write:graphql",
    ]);
    expect(calls[1].variables).toMatchObject({
      input: {
        branch: {
          repositoryNameWithOwner: "contributor/openclaw",
          branchName: "contributor/change",
        },
        expectedHeadOid: headSha,
        fileChanges: {
          additions: [
            {
              contents: Buffer.from("base lockfile").toString("base64"),
              path: "pnpm-lock.yaml",
            },
          ],
          deletions: [],
        },
      },
    });
  });

  it("renders a cleared guard comment that preserves approval freshness", () => {
    const body = renderClearedDependencyGuardComment({ headSha });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency graph guard cleared");
    expect(body).toContain(headSha);
    expect(body).toContain("requires a fresh `/allow-dependencies-change` comment");
  });

  it("parses explicit security approver allowlists", () => {
    expect(securityApproverSet("vincentkoc, steipete\njoshavant")).toEqual(
      new Set(["vincentkoc", "steipete", "joshavant"]),
    );
  });

  it("sanitizes display values", () => {
    expect(sanitizeDisplayValue("abc\u0000def")).toBe("abc?def");
    expect(sanitizeDisplayValue("x".repeat(300))).toHaveLength(240);
  });

  it("bounds GitHub error bodies by content-length", async () => {
    const response = new Response("ignored", {
      headers: { "content-length": String(GITHUB_ERROR_BODY_MAX_BYTES + 1) },
    });

    await expect(readBoundedGitHubErrorText(response)).rejects.toThrow(
      `GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
    );
  });

  it("bounds GitHub error bodies by streamed bytes", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(GITHUB_ERROR_BODY_MAX_BYTES + 1));
          controller.close();
        },
      }),
    );

    await expect(readBoundedGitHubErrorText(response)).rejects.toThrow(
      `GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
    );
  });

  it("preserves GitHub status when an error body exceeds the cap", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(GITHUB_ERROR_BODY_MAX_BYTES + 1));
              controller.close();
            },
          }),
          { status: 403, statusText: "Forbidden" },
        ),
      )) as typeof fetch;

    try {
      await expect(githubApi("token").request("/repos/openclaw/openclaw")).rejects.toMatchObject({
        message: `403 Forbidden: GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
        status: 403,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts stalled GitHub API fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = githubApi("token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return new Promise(() => {});
      }) as typeof fetch,
    }).request("/repos/openclaw/openclaw");
    const rejection = expect(request).rejects.toThrow(
      /GitHub API GET \/repos\/openclaw\/openclaw exceeded timeout 5ms/u,
    );

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the GitHub API timeout active while reading response bodies", async () => {
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = githubApi("token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start() {},
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }) as typeof fetch,
    }).request("/repos/openclaw/openclaw");
    const rejection = expect(request).rejects.toThrow(
      /GitHub API GET \/repos\/openclaw\/openclaw exceeded timeout 5ms/u,
    );

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });
});
