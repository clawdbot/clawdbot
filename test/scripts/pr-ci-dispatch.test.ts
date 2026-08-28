import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchScript = join(process.cwd(), "scripts/pr-lib/ci-dispatch.mjs");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "1111111111111111111111111111111111111111";
const workflowSha = "2222222222222222222222222222222222222222";
const changedSha = "fedcba9876543210fedcba9876543210fedcba98";
const runUrl = "https://github.com/openclaw/openclaw/actions/runs/99";
const summary = formatCrabboxGateCheckSummary({
  baseSha,
  headSha,
  leaseId: "cbx_def456",
  planDigest: "a".repeat(64),
  runId: "run_abc123",
  targetCount: 7,
  workflowSha,
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

function createFakeGh() {
  const tempDir = tempDirs.make("openclaw-pr-ci-dispatch-");
  const binDir = join(tempDir, "bin");
  const pathGh = join(binDir, "gh");
  const realGh = join(tempDir, "real-gh");
  const calls = join(tempDir, "calls.log");
  const dispatched = join(tempDir, "dispatched");
  mkdirSync(binDir);
  const fakeGhScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$(basename "$0")" "$*" >> "$OPENCLAW_TEST_GH_CALLS"
case "$1 $2" in
  "auth token") printf 'forwarded-test-token\\n' ;;
  "pr view")
    if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ] && [ "\${OPENCLAW_TEST_GH_MODE:-}" = "head-change" ]; then
      printf '%s\\n' "$OPENCLAW_TEST_CHANGED_HEAD_SHA"
    else
      printf '%s\\n' "$OPENCLAW_TEST_HEAD_SHA"
    fi
    ;;
  "workflow run")
    test "\${GH_TOKEN-}" = "forwarded-test-token"
    : > "$OPENCLAW_TEST_GH_DISPATCHED"
    ;;
  "api --method")
    case "$4" in
      *"/actions/workflows/"*"/runs")
        if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ]; then
          printf '%s\\n' "$OPENCLAW_TEST_RUN_LIST"
        else
          printf '{"workflow_runs":[]}\\n'
        fi
        ;;
      *"/actions/runs/99") printf '%s\\n' "$OPENCLAW_TEST_RUN" ;;
      *) echo "unexpected API: $*" >&2; exit 2 ;;
    esac
    ;;
  "api --paginate") printf '%s\\n' "$OPENCLAW_TEST_CHECK_PAGES" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 2 ;;
esac
`;
  writeFileSync(pathGh, fakeGhScript);
  writeFileSync(realGh, fakeGhScript);
  chmodSync(pathGh, 0o755);
  chmodSync(realGh, 0o755);
  return { binDir, calls, dispatched, realGh };
}

function runDispatch(
  fakeGh: ReturnType<typeof createFakeGh>,
  options: {
    backend?: "ci" | "crabbox";
    checkOnLaterPage?: boolean;
    mode?: "head-change";
    wrongCheck?: boolean;
  } = {},
) {
  const crabbox = options.backend === "crabbox";
  const runList = {
    workflow_runs: [
      {
        display_title: crabbox ? `PR Crabbox gate #12345 / ${headSha}` : "CI",
        head_branch: crabbox ? "main" : "contributor/fix-hosted-gates",
        head_sha: crabbox ? workflowSha : headSha,
        html_url: runUrl,
        id: 99,
      },
    ],
  };
  const check = {
    app: { id: options.wrongCheck ? 1 : 15368 },
    conclusion: "success",
    details_url: runUrl,
    head_sha: headSha,
    id: 88,
    name: "openclaw/crabbox-gate",
    output: { summary },
    status: "completed",
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_GH_BIN: fakeGh.realGh,
    OPENCLAW_TEST_CHANGED_HEAD_SHA: changedSha,
    OPENCLAW_TEST_CHECK_PAGES: JSON.stringify([
      {
        check_runs: options.checkOnLaterPage
          ? [{ ...check, id: 77, name: "unrelated/check" }]
          : [check],
      },
      ...(options.checkOnLaterPage ? [{ check_runs: [check] }] : []),
    ]),
    OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
    OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
    OPENCLAW_TEST_GH_MODE: options.mode ?? "",
    OPENCLAW_TEST_HEAD_SHA: headSha,
    OPENCLAW_TEST_RUN: JSON.stringify({
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: workflowSha,
      html_url: runUrl,
      id: 99,
      path: ".github/workflows/pr-crabbox-gate-publisher.yml",
      status: "completed",
    }),
    OPENCLAW_TEST_RUN_LIST: JSON.stringify(runList),
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
      headSha,
      baseSha,
      "false",
      ...(crabbox ? ["--backend", "crabbox"] : []),
    ],
    { encoding: "utf8", env },
  );
}

describePosix("scripts/pr ci-dispatch", () => {
  it("dispatches ordinary CI for the exact remote head", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`observed_run_url=${runUrl}`);
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).toContain(
      `real-gh\tworkflow run ci.yml --ref contributor/fix-hosted-gates -f target_ref=${headSha} -f release_gate=true -f pull_request_number=12345`,
    );
  });

  it("finds the publisher-owned Crabbox proof on a later check-run page", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh, { backend: "crabbox", checkOnLaterPage: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      JSON.stringify({
        actionsRunId: 99,
        actionsRunUrl: runUrl,
        backend: "crabbox",
        checkId: 88,
        provider: "aws",
        target: "linux",
        baseSha,
        headSha,
        leaseId: "cbx_def456",
        planDigest: "a".repeat(64),
        runId: "run_abc123",
        targetCount: 7,
        workflowSha,
      }),
    );
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).toContain(
      `real-gh\tworkflow run pr-crabbox-gate-publisher.yml --ref main -f pr_number=12345 -f head_sha=${headSha} -f base_sha=${baseSha}`,
    );
    expect(calls).toContain(`gh\tapi --method GET repos/openclaw/openclaw/actions/runs/99`);
    expect(calls).toContain(
      `gh\tapi --paginate --slurp repos/openclaw/openclaw/commits/${headSha}/check-runs?filter=latest&per_page=100`,
    );
  });

  it("rejects caller-supplied proof handles", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [
        dispatchScript,
        "12345",
        "contributor/fix-hosted-gates",
        headSha,
        baseSha,
        "false",
        "--backend",
        "crabbox",
        "--run-id",
        "run_attacker",
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
    expect(existsSync(fakeGh.dispatched)).toBe(false);
  });

  it("fails closed for a check from the wrong app", () => {
    const result = runDispatch(createFakeGh(), { backend: "crabbox", wrongCheck: true });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /without the exact-head GitHub Actions check/u,
    );
  });

  it("rechecks the remote head after dispatch", () => {
    const result = runDispatch(createFakeGh(), { mode: "head-change" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/head changed/u);
  });

  it("rejects fork PRs before invoking GitHub", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [dispatchScript, "12345", "fix", headSha, baseSha, "true"],
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
    expect(existsSync(fakeGh.calls)).toBe(false);
  });
});
