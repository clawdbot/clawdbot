import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchScript = join(process.cwd(), "scripts/pr-lib/ci-dispatch.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "1111111111111111111111111111111111111111";
const changedSha = "fedcba9876543210fedcba9876543210fedcba98";
const describePosix = process.platform === "win32" ? describe.skip : describe;

function createFakeGh() {
  const tempDir = tempDirs.make("openclaw-pr-ci-dispatch-");
  const binDir = join(tempDir, "bin");
  const pathGh = join(binDir, "gh");
  const realGh = join(tempDir, "real-gh");
  const calls = join(tempDir, "calls.log");
  const dispatched = join(tempDir, "dispatched");
  const seenRunList = join(tempDir, "seen-run-list");
  mkdirSync(binDir);
  const fakeGhScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$(basename "$0")" "$*" >> "$OPENCLAW_TEST_GH_CALLS"
case "$1 $2" in
  "auth token") printf 'forwarded-test-token\\n' ;;
  "api --method")
    if [ "\${OPENCLAW_TEST_GH_MODE:-}" = "pending-head-change" ]; then
      printf '{"workflow_runs":[]}\\n'
    elif [ -e "$OPENCLAW_TEST_GH_SEEN_RUN_LIST" ]; then
      printf '{"workflow_runs":[{"id":99,"html_url":"https://github.com/openclaw/openclaw/actions/runs/99","head_sha":"%s","head_branch":"main","display_title":"PR Crabbox gate #12345 / run_abc123","created_at":"2026-01-01T00:00:00Z","status":"queued"}]}\\n' "$OPENCLAW_TEST_HEAD_SHA"
    else
      : > "$OPENCLAW_TEST_GH_SEEN_RUN_LIST"
      printf '{"workflow_runs":[]}\\n'
    fi
    ;;
  "pr view")
    if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ] && [ -n "\${OPENCLAW_TEST_GH_MODE:-}" ]; then
      printf '%s\\n' "$OPENCLAW_TEST_CHANGED_HEAD_SHA"
    else
      printf '%s\\n' "$OPENCLAW_TEST_HEAD_SHA"
    fi
    ;;
  "workflow run")
    if [ "\${GH_TOKEN-}" != "forwarded-test-token" ]; then
      echo "missing forwarded credentials" >&2
      exit 3
    fi
    : > "$OPENCLAW_TEST_GH_DISPATCHED"
    ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 2 ;;
esac
`;
  writeFileSync(pathGh, fakeGhScript);
  writeFileSync(realGh, fakeGhScript);
  chmodSync(pathGh, 0o755);
  chmodSync(realGh, 0o755);
  return { binDir, calls, dispatched, realGh, seenRunList };
}

function runDispatch(
  fakeGh: ReturnType<typeof createFakeGh>,
  options: {
    backend?: "ci" | "crabbox";
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    OPENCLAW_GH_BIN: fakeGh.realGh,
    OPENCLAW_TEST_CHANGED_HEAD_SHA: changedSha,
    OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
    OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
    OPENCLAW_TEST_GH_MODE: options.mode ?? "",
    OPENCLAW_TEST_GH_SEEN_RUN_LIST: fakeGh.seenRunList,
    OPENCLAW_TEST_HEAD_SHA: sha,
    PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
  };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    delete env[name];
  }
  return spawnSync(
    process.execPath,
    [
      dispatchScript,
      "12345",
      "contributor/fix-hosted-gates",
      sha,
      baseSha,
      "false",
      ...(options.backend === "crabbox"
        ? [
            "--backend",
            "crabbox",
            "--run-id",
            "run_abc123",
            "--lease-id",
            "cbx_def456",
            "--bootstrap-sha256",
            "a".repeat(64),
          ]
        : []),
    ],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env,
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
    const calls = readFileSync(fakeGh.calls, "utf8");
    const callLines = calls.trim().split("\n");
    expect(callLines).toContain(
      `real-gh\tworkflow run ci.yml --ref contributor/fix-hosted-gates -f target_ref=${sha} -f release_gate=true -f pull_request_number=12345`,
    );
    expect(callLines).toContain("gh\tauth token");
    expect(callLines).toContain(
      `gh\tapi --method GET repos/openclaw/openclaw/actions/workflows/ci.yml/runs -f event=workflow_dispatch -f head_sha=${sha} -f per_page=20`,
    );
    expect(callLines.some((call) => call.startsWith("gh\tpr view 12345"))).toBe(true);
    expect(callLines.some((call) => /^real-gh\t(?:api|pr view)/u.test(call))).toBe(false);
  });

  it("dispatches the protected-main Crabbox publisher with the immutable proof handle", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh, { backend: "crabbox" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).toContain(
      `real-gh\tworkflow run pr-crabbox-gate-publisher.yml --ref main -f pr_number=12345 -f head_sha=${sha} -f base_sha=${baseSha} -f crabbox_run_id=run_abc123 -f crabbox_lease_id=cbx_def456 -f bootstrap_sha256=${"a".repeat(64)}`,
    );
    expect(calls).toContain(
      "gh\tapi --method GET repos/openclaw/openclaw/actions/workflows/pr-crabbox-gate-publisher.yml/runs -f event=workflow_dispatch -f branch=main -f per_page=20",
    );
  });

  it("rejects an incomplete Crabbox proof handle before dispatch", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [
        dispatchScript,
        "12345",
        "contributor/fix-hosted-gates",
        sha,
        baseSha,
        "false",
        "--backend",
        "crabbox",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: fakeGh.realGh,
          OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
          PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Expected value|requires valid/u);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
  });

  it("refuses a fork-local branch name before invoking GitHub", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [dispatchScript, "12345", "fix-hosted-gates", sha, baseSha, "true"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: fakeGh.realGh,
          OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
          OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
          OPENCLAW_TEST_GH_SEEN_RUN_LIST: fakeGh.seenRunList,
          OPENCLAW_TEST_HEAD_SHA: sha,
          PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
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
