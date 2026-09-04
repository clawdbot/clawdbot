import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = createTempDirTracker();
const preamble = "# Changelog\n\n";
const history = "## 2026.8.31\n\n### Fixes\n\n- Previous release.\n";
const releaseSection = (version: string) =>
  `## ${version}\n\n### Fixes\n\n- Shipped repair (#42).\n\n`;

function runCloseout(options: {
  version?: string;
  branch?: string;
  title?: string;
  base?: string;
  fork?: boolean;
  before?: string;
  after?: string;
  published?: boolean;
  override?: string;
}) {
  const version = options.version ?? "2026.9.1";
  const dir = tempDirs.make("openclaw-pr-closeout-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "CHANGELOG.md"), options.before ?? preamble + history);
  git("add", "CHANGELOG.md");
  git("commit", "-qm", "base");
  const mainSha = git("rev-parse", "HEAD");
  // A real local tag alone must not authorize closeout: origin owns publication.
  if (options.published !== false) {
    git("tag", `v${version}`);
  }
  git("clone", "-q", "--bare", ".", join(dir, "origin.git"));
  git("remote", "add", "origin", join(dir, "origin.git"));
  if (options.published === false) {
    git("tag", `v${version}`);
  }
  const after = options.after ?? preamble + releaseSection(version) + history;
  writeFileSync(join(repo, "CHANGELOG.md"), after);
  git("add", "CHANGELOG.md");
  git("commit", "-qm", "closeout");
  mkdirSync(join(repo, ".local"));
  writeFileSync(join(repo, ".local/pr-meta.env"), "PR_AUTHOR=alice\n");
  const metadata = {
    headRefName: options.branch ?? `release/${version}-main-closeout`,
    title: options.title ?? `chore(release): close out ${version} on main`,
    baseRefName: options.base ?? "main",
    headRefOid: git("rev-parse", "HEAD"),
    isCrossRepository: options.fork ?? false,
  };
  writeFileSync(join(repo, "metadata.json"), JSON.stringify(metadata));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  printf '%s\\n' "$*" >> gh-calls.log
  cat metadata.json
elif [ "$1 $2" = "repo view" ]; then
  echo openclaw/openclaw
else
  exit 1
fi
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$SCRIPTS/pr-lib/common.sh"
source "$SCRIPTS/pr-lib/changelog.sh"
source "$SCRIPTS/pr-lib/gates.sh"
enter_worktree() { PR_MAIN_SHA="$MAIN_SHA"; }
refresh_prep_branch_for_reviewed_head() { :; }
checkout_prep_branch() { :; }
run_quiet_logged() { printf 'gate:%s\\n' "$1"; }
prepare_gates 42
`,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCRIPTS: join(repoRoot, "scripts"),
        MAIN_SHA: mainSha,
        OPENCLAW_TESTBOX: "1",
        OPENCLAW_PR_GATES_REMOTE: "",
        OPENCLAW_ALLOW_ROOT_CHANGELOG_PR: options.override ?? "",
      },
    },
  );
  return { result, repo, after };
}

afterEach(() => tempDirs.cleanup());

describe("release closeout prepare gates", () => {
  it.each([
    { name: "adds the released section" },
    {
      name: "replaces the released section",
      before:
        preamble + releaseSection("2026.9.1").replace("Shipped repair", "Draft repair") + history,
    },
    { name: "accepts stable correction tags", version: "2026.9.1-2" },
    {
      name: "finalizes an unreleased section",
      before: preamble + releaseSection("2026.8.3 (Unreleased)") + history,
    },
    {
      name: "finalizes bare Unreleased",
      before: preamble + releaseSection("Unreleased") + history,
    },
  ])("$name without an override and preserves tagged text", ({ name: _name, ...options }) => {
    const { result, repo, after } = runCloseout(options);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("gate:hosted CI/Testbox gates");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(after);
    expect(readFileSync(join(repo, "gh-calls.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it.each([
    { name: "normal branch", branch: "fix/changelog" },
    { name: "branch suffix", branch: "release/2026.9.1-main-closeout-extra" },
    { name: "wrong title", title: "chore: release" },
    { name: "non-main target", base: "release/2026.9.1" },
    { name: "fork identity", fork: true },
    { name: "beta version", version: "2026.9.1-beta.1" },
    { name: "local-only tag", published: false },
    { name: "different section version", after: preamble + releaseSection("2026.9.2") + history },
    { name: "unreleased section", after: preamble + releaseSection("Unreleased") + history },
    {
      name: "edits older release",
      after: preamble + releaseSection("2026.9.1") + history.replace("Previous", "Changed"),
    },
    { name: "drops older release", after: preamble + releaseSection("2026.9.1") },
    { name: "edits preamble", after: "# Changed\n\n" + releaseSection("2026.9.1") + history },
    {
      name: "duplicate sections",
      after: preamble + releaseSection("2026.9.1").repeat(2) + history,
    },
    {
      name: "removes released section",
      before: preamble + releaseSection("2026.9.1") + history,
      after: preamble + history,
    },
  ])("rejects $name", ({ name: _name, ...options }) => {
    const { result } = runCloseout(options);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CHANGELOG.md is release-owned");
    expect(result.stdout).not.toContain("gate:hosted");
  });

  it("retains the explicit release automation override", () => {
    const { result } = runCloseout({
      branch: "release/automation",
      published: false,
      override: "1",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("checks large release history without a subprocess output limit", () => {
    const largeHistory = history + "- Historical release note.\n".repeat(170_000);
    const { result } = runCloseout({
      before: preamble + largeHistory,
      after: preamble + releaseSection("2026.9.1") + largeHistory,
    });
    expect(result.status).toBe(0);
  });
});
