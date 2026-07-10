import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contaminatingPullRequestReferences,
  countTopLevelSectionBullets,
  cumulativeShippedPullRequests,
  highlightCountError,
  releaseNoteReferences,
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
        [verifier, "--base", "base-ref", "--target", "HEAD", "--version", "2026.7.1"],
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
