import { describe, expect, it } from "vitest";
import {
  dependencyGuardCommentHeadSha,
  dependencyFieldChanges,
  dependencyOverrideExpectedSha,
  findDependencyOverrideCommand,
  findDependencyOverrideCommandAsync,
  isDependencyGuardAuthorizedForHead,
  isDependencyFile,
  isDependencyManifest,
  isPackageLockfile,
  renderAuthorizedDependencyComment,
  renderBlockedDependencyComment,
  renderClearedDependencyGuardComment,
  sanitizeDisplayValue,
  securityApproverSet,
} from "../../scripts/github/dependency-guard.mjs";

const headSha = "a".repeat(40);
const staleSha = "b".repeat(40);

describe("dependency guard script", () => {
  it("detects dependency awareness file surfaces", () => {
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
});
