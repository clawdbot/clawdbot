// Check Changelog Attributions tests cover check changelog attributions script behavior.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mjs";

const changelogScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "changelog.sh");
const commonScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "common.sh");
const gatesScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "gates.sh");

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandOutput(error: unknown): string {
  const result = error as { stderr?: unknown; stdout?: unknown };
  return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
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

function createRepoWithChangelog(content: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "openclaw-changelog-policy-"));
  writeFileSync(repo + "/CHANGELOG.md", content, "utf8");
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

function validateChangelogAttributionPolicy(repo: string): string {
  return run(
    repo,
    "bash",
    ["-c", 'source "$OPENCLAW_PR_CHANGELOG_SH"; validate_changelog_attribution_policy'],
    {
      OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
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

  it("runs the shell attribution policy over real changelog content", () => {
    const forbiddenRepo = createRepoWithChangelog(
      "# Changelog\n\n## Unreleased\n\n### Fixes\n\n- Bot repair. Thanks @dependabot[bot].\n",
    );
    try {
      let output = "";
      try {
        validateChangelogAttributionPolicy(forbiddenRepo);
      } catch (error) {
        output = String((error as { stderr?: unknown }).stderr ?? error);
      }
      expect(output).toContain("Forbidden changelog thanks attribution");
      expect(output).toContain("CHANGELOG.md:7 uses Thanks @dependabot[bot]");
    } finally {
      rmSync(forbiddenRepo, { recursive: true, force: true });
    }

    const allowedRepo = createRepoWithChangelog(
      "# Changelog\n\n## Unreleased\n\n### Fixes\n\n- User fix. Thanks @alice.\n",
    );
    try {
      expect(validateChangelogAttributionPolicy(allowedRepo)).toBe("");
    } finally {
      rmSync(allowedRepo, { recursive: true, force: true });
    }
  });

  it("rejects root changelog updates from normal prepare gates", () => {
    const repo = createRepoWithPrChangelogDiff("- User fix (#123). Thanks @alice.");
    const callsPath = path.join(repo, "calls.log");
    mkdirSync(path.join(repo, ".local"));
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_AUTHOR=alice\n", "utf8");
    try {
      let output = "";
      try {
        run(
          repo,
          "bash",
          [
            "-c",
            `
set -euo pipefail
source "$OPENCLAW_PR_COMMON_SH"
source "$OPENCLAW_PR_CHANGELOG_SH"
source "$OPENCLAW_PR_GATES_SH"

enter_worktree() { :; }
checkout_prep_branch() { :; }
refresh_prep_branch_for_reviewed_head() { :; }
bootstrap_deps_if_needed() { :; }
require_artifact() { [ -s "$1" ]; }
normalize_pr_changelog_entries() { printf 'normalize\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_attribution_policy() { printf 'policy\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_merge_hygiene() { printf 'merge-hygiene\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_entry_for_pr() { printf 'entry:%s:%s\\n' "$1" "$2" >>"$OPENCLAW_TEST_CALLS"; }
run_quiet_logged() { printf 'gate:%s\\n' "$1" >>"$OPENCLAW_TEST_CALLS"; }

prepare_gates 123
`,
          ],
          {
            OPENCLAW_PR_COMMON_SH: commonScriptPath,
            OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
            OPENCLAW_PR_GATES_SH: gatesScriptPath,
            OPENCLAW_TEST_CALLS: callsPath,
            OPENCLAW_TESTBOX: "0",
          },
        );
      } catch (error) {
        output = commandOutput(error);
      }
      const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";

      expect(output).toContain("CHANGELOG.md is release-owned");
      expect(calls).not.toContain("normalize");
      expect(calls).not.toContain("policy");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("allows explicit release automation to run changelog policy from prepare gates", () => {
    const repo = createRepoWithPrChangelogDiff("- User fix (#123). Thanks @alice.");
    const callsPath = path.join(repo, "calls.log");
    mkdirSync(path.join(repo, ".local"));
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_AUTHOR=alice\n", "utf8");
    try {
      const output = run(
        repo,
        "bash",
        [
          "-c",
          `
set -euo pipefail
source "$OPENCLAW_PR_COMMON_SH"
source "$OPENCLAW_PR_CHANGELOG_SH"
source "$OPENCLAW_PR_GATES_SH"

enter_worktree() { :; }
checkout_prep_branch() { :; }
refresh_prep_branch_for_reviewed_head() { :; }
bootstrap_deps_if_needed() { :; }
require_artifact() { [ -s "$1" ]; }
normalize_pr_changelog_entries() { printf 'normalize\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_attribution_policy() { printf 'policy\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_merge_hygiene() { printf 'merge-hygiene\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_entry_for_pr() { printf 'entry:%s:%s\\n' "$1" "$2" >>"$OPENCLAW_TEST_CALLS"; }
run_quiet_logged() { printf 'gate:%s\\n' "$1" >>"$OPENCLAW_TEST_CALLS"; }

prepare_gates 123
`,
        ],
        {
          OPENCLAW_ALLOW_ROOT_CHANGELOG_PR: "1",
          OPENCLAW_PR_COMMON_SH: commonScriptPath,
          OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
          OPENCLAW_PR_GATES_SH: gatesScriptPath,
          OPENCLAW_TEST_CALLS: callsPath,
          OPENCLAW_TESTBOX: "0",
        },
      );
      const calls = readFileSync(callsPath, "utf8");

      expect(output).toContain("docs_only=true");
      expect(calls).toContain("normalize\npolicy\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
