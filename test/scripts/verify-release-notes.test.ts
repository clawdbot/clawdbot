import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalMainCommitMatches,
  canonicalPullRequests,
  contaminatingPullRequestReferences,
  countTopLevelSectionBullets,
  createGithubSnapshotState,
  cumulativeShippedPullRequests,
  defaultGithubSnapshotPath,
  githubApiWithSnapshot,
  highlightCountError,
  persistGithubSnapshot,
  releaseNoteReferences,
  renderedContributionRecordReferences,
  standardRevertedHash,
  subtractShippedPullRequests,
  withoutExcludedContributionRecords,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const verifier = resolve(
  ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
  }).trim();
}

describe("release-note verification", () => {
  it("stores default GitHub snapshots in the shared Git common directory", () => {
    const commonDir = resolve("/tmp/openclaw-shared-git");
    expect(defaultGithubSnapshotPath("a".repeat(40), "b".repeat(40), commonDir)).toBe(
      join(
        commonDir,
        "openclaw-release-cache",
        `verify-release-notes-${"a".repeat(40)}-${"b".repeat(40)}.json`,
      ),
    );
  });

  it("uses the original main PR for explicit and uniquely matched backports", () => {
    const mainCommit = {
      authorEmail: "maintainer@example.com",
      authorName: "Maintainer",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "a".repeat(40),
      pullRequests: [123],
      subject: "fix(channel): preserve durable replies",
    };
    const explicitBackport = {
      authorEmail: "other@example.com",
      authorName: "Other",
      body: `(cherry picked from commit ${mainCommit.hash})`,
      changedPaths: new Set(["src/channel.ts"]),
      hash: "b".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const integratedBackport = {
      authorEmail: mainCommit.authorEmail,
      authorName: mainCommit.authorName,
      body: "",
      changedPaths: new Set(["src/channel.ts", "src/release.ts"]),
      hash: "c".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const pullRequestBackport = {
      authorEmail: mainCommit.authorEmail,
      authorName: mainCommit.authorName,
      body: "Backport of #123 to release/2026.7.1.",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "d".repeat(40),
      subject: "fix(channel): keep replies after renewal",
    };

    expect(canonicalMainCommitMatches(explicitBackport, [mainCommit])).toEqual([mainCommit.hash]);
    expect(canonicalMainCommitMatches(integratedBackport, [mainCommit])).toEqual([mainCommit.hash]);
    expect(canonicalMainCommitMatches(pullRequestBackport, [mainCommit])).toEqual([
      mainCommit.hash,
    ]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        {
          ...mainCommit,
          pullRequests: [],
          body: "Original main PR #123.",
          subject: "fix(channel): preserve durable replies",
        },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        {
          ...mainCommit,
          pullRequests: [999],
          subject: "fix(channel): keep replies after renewal",
        },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(
        { ...pullRequestBackport, authorEmail: "other@example.com", authorName: "Other" },
        [mainCommit],
      ),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(
        { ...pullRequestBackport, changedPaths: new Set(["src/other.ts"]) },
        [mainCommit],
      ),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches({ ...pullRequestBackport, body: "Related #123." }, [mainCommit]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        mainCommit,
        { ...mainCommit, hash: "e".repeat(40), pullRequests: [123] },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        mainCommit,
        {
          ...mainCommit,
          body: "Original main PR #123.",
          hash: "f".repeat(40),
          pullRequests: [],
        },
      ]),
    ).toEqual([mainCommit.hash]);
    expect(canonicalPullRequests([456], [123])).toEqual([123]);
  });

  it("keeps the release PR without an unambiguous main forward-port", () => {
    const releaseCommit = {
      authorEmail: "maintainer@example.com",
      authorName: "Maintainer",
      body: "",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "c".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const ambiguousMainCommits = ["a", "b"].map((prefix) => ({
      authorEmail: releaseCommit.authorEmail,
      authorName: releaseCommit.authorName,
      changedPaths: new Set(["src/channel.ts"]),
      hash: prefix.repeat(40),
      subject: "fix(channel): preserve durable replies (#123)",
    }));

    expect(canonicalMainCommitMatches(releaseCommit, ambiguousMainCommits)).toEqual([]);
    expect(canonicalPullRequests([456], [])).toEqual([456]);
  });

  it("drops the release PR when the matching main forward-port is a direct commit", () => {
    expect(canonicalPullRequests([456], [], true)).toEqual([]);
  });

  it("reuses exact-range GitHub GraphQL snapshots without caching REST reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      let fetches = 0;
      const fetchApi = (args: string[]) => {
        fetches += 1;
        return { data: { request: args, fetches } };
      };
      const first = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });

      expect(githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, first)).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(
        githubApiWithSnapshot(["repos/openclaw/openclaw/releases/tags/v1"], fetchApi, first),
      ).toEqual({
        data: {
          request: ["repos/openclaw/openclaw/releases/tags/v1"],
          fetches: 2,
        },
      });
      persistGithubSnapshot(first);

      const second = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      expect(githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, second)).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(second.hits).toBe(1);
      expect(second.misses).toBe(0);
      expect(fetches).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("checkpoints successful GraphQL responses during long verification runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        checkpointEvery: 2,
        filePath,
        target: "b".repeat(40),
      });
      const fetchApi = (args: string[]) => ({ data: { request: args } });

      githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, state);
      expect(state.dirty).toBe(true);
      expect(state.writesSincePersist).toBe(1);
      githubApiWithSnapshot(["graphql", "-f", "query=two"], fetchApi, state);

      expect(state.dirty).toBe(false);
      expect(state.writesSincePersist).toBe(0);
      expect(JSON.parse(readFileSync(filePath, "utf8")).responses).toHaveProperty(
        JSON.stringify(["graphql", "-f", "query=two"]),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not cache transient GraphQL errors", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      let fetches = 0;
      const fetchApi = () => {
        fetches += 1;
        return fetches === 1
          ? { errors: [{ message: "rate limited" }] }
          : { data: { repository: { id: "repository-id" } } };
      };
      const args = ["graphql", "-f", "query=one"];

      expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({
        errors: [{ message: "rate limited" }],
      });
      expect(state.dirty).toBe(false);
      expect(state.responses).toEqual({});
      expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({
        data: { repository: { id: "repository-id" } },
      });
      expect(state.misses).toBe(2);
      expect(fetches).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot bound to a different release target", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      githubApiWithSnapshot(["graphql", "-f", "query=one"], () => ({ data: true }), state);
      persistGithubSnapshot(state);

      expect(() =>
        createGithubSnapshotState({
          base: "a".repeat(40),
          filePath,
          target: "c".repeat(40),
        }),
      ).toThrow("use --refresh-github-snapshot");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores nested revert markers in squash-merge bodies", () => {
    const nestedRevert = [
      "feat(android): render display math (#101435)",
      "",
      "* feat(android): render display math",
      "",
      ' * Revert "docs(changelog): note display math"',
      "",
      `This reverts commit ${"a".repeat(40)}.`,
    ].join("\n");
    const topLevelRevert = [
      'Revert "fix(qa): keep smoke profile on one channel (#101173)" (#101184)',
      "",
      `This reverts commit ${"b".repeat(40)}.`,
    ].join("\n");
    const squashRevert = [
      "Revert chat session picker inline search (#85527)",
      "",
      '* Revert "fix(ui): keep chat session search inline (#85490)"',
      "",
      `This reverts commit ${"c".repeat(40)}.`,
      "",
      "* fix(ui): clear applied chat picker search on empty input",
    ].join("\n");
    const conventionalSquashRevert = [
      "chore: revert dependency guard backfill machinery (#87867)",
      "",
      '* Revert "ci: isolate dependency guard backfill label (#87882)"',
      "",
      `This reverts commit ${"d".repeat(40)}.`,
      "",
      "* ci: preserve clawsweeper bot label filter",
    ].join("\n");
    const explainedTopLevelRevert = [
      "revert: restore a provider default",
      "",
      "The replacement broke non-native endpoints.",
      "",
      `This reverts commit ${"e".repeat(40)}.`,
    ].join("\n");

    expect(standardRevertedHash(nestedRevert)).toBeUndefined();
    expect(standardRevertedHash(topLevelRevert)).toBe("b".repeat(40));
    expect(standardRevertedHash(squashRevert)).toBe("c".repeat(40));
    expect(standardRevertedHash(conventionalSquashRevert)).toBe("d".repeat(40));
    expect(standardRevertedHash(explainedTopLevelRevert)).toBe("e".repeat(40));
  });

  it("counts only top-level Highlights bullets and enforces the 5-8 policy input", () => {
    const highlights = [
      "### Highlights",
      "",
      "- One",
      "  - nested detail",
      "- Two",
      "- Three",
      "- Four",
      "- Five",
      "",
      "### Changes",
      "",
      "- Not a highlight",
    ].join("\n");
    const overLimit = highlights.replace("- Five", "- Five\n- Six\n- Seven\n- Eight\n- Nine");

    expect(countTopLevelSectionBullets(highlights, "Highlights")).toBe(5);
    expect(countTopLevelSectionBullets(overLimit, "Highlights")).toBe(9);
    expect(highlightCountError(highlights)).toBeUndefined();
    expect(highlightCountError(overLimit)).toBe(
      "### Highlights must contain 5-8 top-level bullets; found 9",
    );
  });

  it("rejects prior-release PRs from prose or the existing record unless explicitly seeded", () => {
    const nodes = new Map([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
      [98565, { __typename: "Issue" }],
    ]);
    const params = {
      noteReferences: [97118, 98565],
      recordedReferences: [97118, 102000],
      sourcePullRequests: new Set([102000]),
      sourceReferences: [102000, 98565],
      seededPullRequests: new Set<number>(),
      nodes,
    };

    expect(contaminatingPullRequestReferences(params)).toEqual([97118]);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        seededPullRequests: new Set([97118]),
      }),
    ).toEqual([]);
  });

  it("ignores the stale generated record while rewriting it", () => {
    const record = {
      pullRequests: new Map([[104732, { references: [102289], thanks: ["fuller-stack-dev"] }]]),
      legacyIssues: new Map(),
    };

    expect(renderedContributionRecordReferences(record, true)).toEqual([]);
    expect(renderedContributionRecordReferences(record, false)).toEqual([104732, 102289]);
  });

  it("excludes Unreleased records from a cumulative shipped tag boundary", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

    expect([...cumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("subtracts cumulative shipped PRs deterministically from the source inventory", () => {
    const source = {
      pullRequests: new Set([1, 2, 3]),
      references: [1, 2, 4],
    };

    const result = subtractShippedPullRequests(source, [
      { ref: "v2026.6.11", pullRequests: new Set([1, 2]) },
      { ref: "v2026.6.10", pullRequests: new Set([2, 4]) },
    ]);

    expect([...source.pullRequests]).toEqual([3]);
    expect(source.references).toEqual([]);
    expect(result.baselines).toEqual([
      { ref: "v2026.6.10", count: 2, pullRequests: [2, 4] },
      { ref: "v2026.6.11", count: 1, pullRequests: [1] },
    ]);
    expect([...result.pullRequests].toSorted((a, b) => a - b)).toEqual([1, 2, 4]);
  });

  it("removes rewrite-excluded references from an existing contribution record", () => {
    const record = {
      pullRequests: new Map([
        [1, { references: [2, 10], thanks: [] }],
        [2, { references: [11], thanks: [] }],
      ]),
      legacyIssues: new Map([
        [10, { references: [], thanks: [] }],
        [11, { references: [], thanks: [] }],
      ]),
    };

    const filtered = withoutExcludedContributionRecords(record, new Set([2, 10]));

    expect([...filtered.pullRequests]).toEqual([
      [1, { externalReferences: [], references: [], thanks: [] }],
    ]);
    expect([...filtered.legacyIssues]).toEqual([
      [11, { externalReferences: [], references: [], thanks: [] }],
    ]);
  });

  it("does not treat the shipped baseline inventory as current release-note references", () => {
    const baselines = [{ ref: "v2026.6.11", count: 2, pullRequests: [1, 2] }];
    const section = [
      "## 2026.7.1",
      "",
      "- Fixes #1 in the current range.",
      "",
      "### Complete contribution record",
      "",
      "Shipped baseline exclusions: v2026.6.11 (2 PRs: #1, #2).",
      "",
      "- **PR #3** fix: current work.",
    ].join("\n");

    expect(releaseNoteReferences(section, baselines)).toEqual([1, 3]);
  });

  it("records a canonical target SHA when --target is symbolic", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const targetSha = git(cwd, ["rev-parse", "HEAD"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--main-ref",
          "HEAD",
          "--version",
          "2026.7.1",
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).target).toBe(targetSha);
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(
        `This audited record covers the complete HEAD..${targetSha} history:`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a release-only base that shares history with canonical main", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const root = git(cwd, ["rev-parse", "HEAD"]);

      writeFileSync(join(cwd, "main.txt"), "main\n");
      git(cwd, ["add", "main.txt"]);
      git(cwd, ["commit", "-qm", "main"]);
      git(cwd, ["branch", "main-ref"]);

      git(cwd, ["checkout", "-qb", "release", root]);
      writeFileSync(join(cwd, "release.txt"), "release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "-qm", "release"]);
      git(cwd, ["tag", "beta-base"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "beta-base",
          "--target",
          "HEAD",
          "--main-ref",
          "main-ref",
          "--version",
          "2026.7.1",
          "--write-ledger",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a release base that is not an ancestor of the target", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- Test release.",
          "",
          "### Complete contribution record",
          "",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      git(cwd, ["branch", "target"]);

      writeFileSync(join(cwd, "base.txt"), "base\n");
      git(cwd, ["add", "base.txt"]);
      git(cwd, ["commit", "-qm", "base"]);
      git(cwd, ["tag", "base-ref"]);

      git(cwd, ["checkout", "-q", "target"]);
      writeFileSync(join(cwd, "target.txt"), "target\n");
      git(cwd, ["add", "target.txt"]);
      git(cwd, ["commit", "-qm", "target"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "base-ref",
          "--target",
          "HEAD",
          "--main-ref",
          "HEAD",
          "--version",
          "2026.7.1",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release range base base-ref must be an ancestor of target HEAD",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
