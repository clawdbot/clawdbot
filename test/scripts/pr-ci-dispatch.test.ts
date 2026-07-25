import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchScript = join(process.cwd(), "scripts/pr-lib/ci-dispatch.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";
const changedSha = "fedcba9876543210fedcba9876543210fedcba98";
const describePosix = process.platform === "win32" ? describe.skip : describe;

function createFakeGh() {
  const tempDir = tempDirs.make("openclaw-pr-ci-dispatch-");
  const fakeGh = join(tempDir, "gh");
  const calls = join(tempDir, "calls.log");
  const dispatched = join(tempDir, "dispatched");
  const seenRunList = join(tempDir, "seen-run-list");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_GH_CALLS"
case "$1 $2" in
  "run list")
    if [ "\${OPENCLAW_TEST_GH_MODE:-}" = "pending-head-change" ]; then
      printf '[]\\n'
    elif [ -e "$OPENCLAW_TEST_GH_SEEN_RUN_LIST" ]; then
      printf '[{"databaseId":99,"url":"https://github.com/openclaw/openclaw/actions/runs/99","headSha":"%s","createdAt":"2026-01-01T00:00:00Z","status":"queued"}]\\n' "$OPENCLAW_TEST_HEAD_SHA"
    else
      : > "$OPENCLAW_TEST_GH_SEEN_RUN_LIST"
      printf '[]\\n'
    fi
    ;;
  "pr view")
    if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ] && [ -n "\${OPENCLAW_TEST_GH_MODE:-}" ]; then
      printf '%s\\n' "$OPENCLAW_TEST_CHANGED_HEAD_SHA"
    else
      printf '%s\\n' "$OPENCLAW_TEST_HEAD_SHA"
    fi
    ;;
  "workflow run") : > "$OPENCLAW_TEST_GH_DISPATCHED" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);
  return { calls, dispatched, fakeGh, seenRunList };
}

function runDispatch(
  fakeGh: ReturnType<typeof createFakeGh>,
  options: {
    mode?: "observed-head-change" | "pending-head-change";
    immediateTimers?: boolean;
    cwd?: string;
  } = {},
) {
  let nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (options.immediateTimers) {
    const preload = join(tempDirs.make("openclaw-pr-ci-dispatch-timers-"), "immediate-timers.cjs");
    writeFileSync(preload, "global.setTimeout = (callback) => { callback(); return 0; };\n");
    nodeOptions = `${nodeOptions} --require ${preload}`.trim();
  }
  return spawnSync(
    process.execPath,
    [dispatchScript, "12345", "contributor/fix-hosted-gates", sha, "false"],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        OPENCLAW_GH_BIN: fakeGh.fakeGh,
        OPENCLAW_TEST_CHANGED_HEAD_SHA: changedSha,
        OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
        OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
        OPENCLAW_TEST_GH_MODE: options.mode ?? "",
        OPENCLAW_TEST_GH_SEEN_RUN_LIST: fakeGh.seenRunList,
        OPENCLAW_TEST_HEAD_SHA: sha,
      },
    },
  );
}

describePosix("scripts/pr ci-dispatch", () => {
  it("warns when a same-named local branch points away from the dispatched remote head", () => {
    const repo = tempDirs.make("openclaw-pr-ci-dispatch-repo-");
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x");
    git("branch", "contributor/fix-hosted-gates");

    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh, { cwd: repo });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("warning: local branch contributor/fix-hosted-gates is at");
    expect(result.stderr).toContain(`remote head ${sha}`);
  });

  it("stays silent when no same-named local branch exists", () => {
    const repo = tempDirs.make("openclaw-pr-ci-dispatch-repo-");
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, encoding: "utf8" });

    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh, { cwd: repo });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("warning: local branch");
  });

  it("dispatches the exact CI workflow for the remote PR head", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "observed_run_url=https://github.com/openclaw/openclaw/actions/runs/99",
    );
    expect(readFileSync(fakeGh.calls, "utf8")).toContain(
      `workflow run ci.yml --ref contributor/fix-hosted-gates -f target_ref=${sha} -f release_gate=true -f pull_request_number=12345`,
    );
  });

  it("refuses a fork-local branch name before invoking GitHub", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [dispatchScript, "12345", "fix-hosted-gates", sha, "true"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: fakeGh.fakeGh,
          OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
          OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
          OPENCLAW_TEST_GH_SEEN_RUN_LIST: fakeGh.seenRunList,
          OPENCLAW_TEST_HEAD_SHA: sha,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/comes from a fork/u);
    expect(existsSync(fakeGh.calls)).toBe(false);
  });

  it("fails closed if the remote head changes while CI run indexing is pending", () => {
    const result = runDispatch(createFakeGh(), {
      immediateTimers: true,
      mode: "pending-head-change",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /head changed while CI dispatch was being indexed/u,
    );
  });

  it("rechecks the remote head before returning an observed exact-SHA run", () => {
    const result = runDispatch(createFakeGh(), { mode: "observed-head-change" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /head changed before an exact-SHA CI run became visible/u,
    );
  });
});
