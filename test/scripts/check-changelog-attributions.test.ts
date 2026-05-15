import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mjs";

const changelogScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "changelog.sh");

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function createRepoWithPrChangelogDiff(entry: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "openclaw-changelog-credit-"));
  run(repo, "git", ["init", "-q", "--initial-branch=main"]);
  run(repo, "git", ["config", "user.email", "test@example.com"]);
  run(repo, "git", ["config", "user.name", "Test User"]);
  writeFileSync(repo + "/CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n### Fixes\n\n", "utf8");
  run(repo, "git", ["add", "CHANGELOG.md"]);
  run(repo, "git", ["commit", "-qm", "seed"]);
  const baseSha = run(repo, "git", ["rev-parse", "HEAD"]);
  // validate_changelog_entry_for_pr reads origin/main...HEAD, so the test
  // fixture needs a real base ref plus a feature-branch changelog diff.
  run(repo, "git", ["update-ref", "refs/remotes/origin/main", baseSha]);
  run(repo, "git", ["checkout", "-qb", "feature"]);
  writeFileSync(
    repo + "/CHANGELOG.md",
    `# Changelog\n\n## Unreleased\n\n### Fixes\n\n${entry}\n`,
    "utf8",
  );
  run(repo, "git", ["add", "CHANGELOG.md"]);
  run(repo, "git", ["commit", "-qm", "add changelog entry"]);
  return repo;
}

function validateChangelogEntry(repo: string, contrib: string): string {
  return run(
    repo,
    "bash",
    [
      "-c",
      'source "$OPENCLAW_PR_CHANGELOG_SH"; validate_changelog_entry_for_pr 123 "$OPENCLAW_TEST_CONTRIB"',
    ],
    {
      OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
      OPENCLAW_TEST_CONTRIB: contrib,
    },
  );
}

describe("check-changelog-attributions", () => {
  it("flags forbidden bot, org, and maintainer thanks attributions", () => {
    const content = [
      "- Internal cleanup. Thanks @codex.",
      "- Org-owned fix. Thanks @openclaw.",
      "- Maintainer-owned fix. Thanks @steipete.",
      "- Mixed credit. Thanks @contributor and @OpenClaw.",
      "- Bot repair. Thanks @clawsweeper[bot].",
      "- Dependency bump. Thanks @dependabot[bot].",
      "- App repair. Thanks @app/clawsweeper.",
    ].join("\n");

    expect(findForbiddenChangelogThanks(content)).toEqual([
      { line: 1, handle: "codex", text: "- Internal cleanup. Thanks @codex." },
      { line: 2, handle: "openclaw", text: "- Org-owned fix. Thanks @openclaw." },
      { line: 3, handle: "steipete", text: "- Maintainer-owned fix. Thanks @steipete." },
      { line: 4, handle: "openclaw", text: "- Mixed credit. Thanks @contributor and @OpenClaw." },
      { line: 5, handle: "clawsweeper[bot]", text: "- Bot repair. Thanks @clawsweeper[bot]." },
      { line: 6, handle: "dependabot[bot]", text: "- Dependency bump. Thanks @dependabot[bot]." },
      { line: 7, handle: "app/clawsweeper", text: "- App repair. Thanks @app/clawsweeper." },
    ]);
  });

  it("allows external contributor thanks attributions", () => {
    expect(
      findForbiddenChangelogThanks(
        "- User-facing fix. Fixes #123. Thanks @external-contributor and @other-user.",
      ),
    ).toStrictEqual([]);
  });

  it("checks every thanked handle on a changelog line", () => {
    expect(
      findForbiddenChangelogThanks("- Mixed credit (#123). Thanks @openclaw and @alice."),
    ).toEqual([
      {
        line: 1,
        handle: "openclaw",
        text: "- Mixed credit (#123). Thanks @openclaw and @alice.",
      },
    ]);
  });

  it("uses one attribution predicate for scanner and shell checks", () => {
    expect(isForbiddenChangelogThanksHandle("")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("null")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("app/any-bot")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("codex")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("openclaw")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("steipete")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("app/clawsweeper")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("clawsweeper")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("clawsweeper[bot]")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("openclaw-clawsweeper")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("openclaw-clawsweeper[bot]")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("dependabot[bot]")).toBe(true);
    expect(isForbiddenChangelogThanksHandle("dependabot[bot]", { strictBotHandle: true })).toBe(
      true,
    );
    expect(isForbiddenChangelogThanksHandle("alice")).toBe(false);
    expect(isForbiddenChangelogThanksHandle("human-clawsweeper-fan")).toBe(false);
    expect(
      isForbiddenChangelogThanksHandle("human-clawsweeper-fan", { strictBotHandle: true }),
    ).toBe(false);

    expect(requiresExplicitHumanChangelogThanks("clawsweeper")).toBe(true);
    expect(requiresExplicitHumanChangelogThanks("clawsweeper[bot]")).toBe(true);
    expect(requiresExplicitHumanChangelogThanks("dependabot[bot]")).toBe(true);
    expect(requiresExplicitHumanChangelogThanks("app/clawsweeper")).toBe(true);
    expect(requiresExplicitHumanChangelogThanks("human-clawsweeper-fan")).toBe(false);
    expect(requiresExplicitHumanChangelogThanks("steipete")).toBe(false);
    expect(requiresExplicitHumanChangelogThanks("")).toBe(false);
  });

  it("requires explicit human thanks for bot PR changelog entries", () => {
    const repo = createRepoWithPrChangelogDiff("- Bot repair (#123).");
    try {
      let output = "";
      try {
        validateChangelogEntry(repo, "dependabot[bot]");
      } catch (error) {
        output = String((error as { stdout?: unknown }).stdout ?? error);
      }
      expect(output).toContain("must include an explicit human Thanks @handle");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("accepts explicit human thanks for bot PR changelog entries", () => {
    const repo = createRepoWithPrChangelogDiff("- Bot repair (#123). Thanks @alice.");
    try {
      expect(validateChangelogEntry(repo, "dependabot[bot]")).toContain("explicit thanks");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps non-bot forbidden contributors on the no-thanks fallback", () => {
    const repo = createRepoWithPrChangelogDiff("- Maintainer repair (#123).");
    try {
      expect(validateChangelogEntry(repo, "steipete")).toContain("skipping thanks check");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps PR changelog gates on the same attribution policy", () => {
    const commonLib = readFileSync("scripts/pr-lib/common.sh", "utf8");
    const changelogLib = readFileSync("scripts/pr-lib/changelog.sh", "utf8");
    const gates = readFileSync("scripts/pr-lib/gates.sh", "utf8");
    const mergeLib = readFileSync("scripts/pr-lib/merge.sh", "utf8");
    const prepareCore = readFileSync("scripts/pr-lib/prepare-core.sh", "utf8");

    expect(commonLib).toContain("pr_contributor_allows_human_trailers");
    expect(commonLib).toContain("resolve_contributor_coauthor_email");
    expect(changelogLib).toContain("changelog_attribution_script");
    expect(changelogLib).toContain("--is-forbidden-handle");
    expect(changelogLib).toContain("--requires-explicit-human-thanks");
    expect(changelogLib).toContain("changelog_thanks_required_for_contributor");
    expect(changelogLib).toContain("changelog_explicit_human_thanks_required_for_contributor");
    expect(changelogLib).toContain("Choose the credited original contributor");
    expect(gates).toContain("validate_changelog_attribution_policy");
    expect(prepareCore).toContain("resolve_contributor_coauthor_email");
    expect(mergeLib).toContain("pr_contributor_allows_human_trailers");
    expect(mergeLib).toContain("Skipping PR author co-author trailer check for bot/app author");
  });
});
