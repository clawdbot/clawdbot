// PR wrapper tests cover maintainer helper command delegation.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readScript(path: string): string {
  return readFileSync(path, "utf8");
}

describe("scripts/pr wrappers", () => {
  it("keeps the main PR helper usage and command table aligned", () => {
    const script = readScript("scripts/pr");

    expect(script).toContain("export NO_COLOR=1");
    expect(script).toContain("unset COLORTERM");
    expect(script).toContain('source "$script_parent_dir/lib/plain-gh.sh"');
    expect(script).toContain("OPENCLAW_GH_BIN=");
    expect(script).toContain("gh_plain");
    expect(script).toContain("scripts/pr review-init <PR>");
    expect(script).toContain("scripts/pr prepare-run <PR>");
    expect(script).toContain("scripts/pr merge-run <PR>");
    expect(script).toContain('review_init "$pr"');
    expect(script).toContain('prepare_run "$pr"');
    expect(script).toContain('merge_run "$pr"');
  });

  it("keeps merge wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-merge");

    expect(script).toContain("scripts/pr-merge <PR>");
    expect(script).toContain('exec "$base" merge-verify "$1"');
    expect(script).toContain('exec "$base" merge-verify "$pr"');
    expect(script).toContain('exec "$base" merge-run "$pr"');
  });

  it("defaults to squash and allows commit-preserving merge methods", () => {
    const script = readScript("scripts/pr-lib/merge.sh");

    expect(script).toContain("OPENCLAW_PR_MERGE_METHOD:-squash");
    expect(script).toContain("--squash");
    expect(script).toContain("--merge");
    expect(script).toContain("--rebase");
    expect(script).toContain('echo "Merged via $merge_label."');
  });

  it("keeps prepare wrapper modes delegated to the main PR helper", () => {
    const script = readScript("scripts/pr-prepare");

    expect(script).toContain("scripts/pr-prepare <init|validate-commit|gates|push|run> <PR>");
    for (const mode of ["init", "validate-commit", "gates", "push", "run"]) {
      expect(script).toContain(`${mode})`);
    }
    expect(script).toContain('exec "$base" prepare-init "$pr"');
    expect(script).toContain('exec "$base" prepare-validate-commit "$pr"');
    expect(script).toContain('exec "$base" prepare-gates "$pr"');
    expect(script).toContain('exec "$base" prepare-push "$pr"');
    expect(script).toContain('exec "$base" prepare-run "$pr"');
  });

  it("keeps review wrapper delegated to review-init", () => {
    const script = readScript("scripts/pr-review");

    expect(script).toContain('base="$script_dir/pr"');
    expect(script).toContain('exec "$base" review-init "$@"');
  });

  it("verifies local GitHub auth through GraphQL when REST quota is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-auth-"));
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  printf 'monalisa\\n'
  exit 0
fi
exit 1
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "bash",
      [
        "-c",
        "source scripts/lib/plain-gh.sh; source scripts/pr-lib/worktree.sh; ensure_gh_api_auth",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_GH_BIN: gh },
        encoding: "utf8",
      },
    );
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
