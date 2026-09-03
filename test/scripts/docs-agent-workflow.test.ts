import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mainSha = "a".repeat(40);
const parentSha = "b".repeat(40);
const previousSha = "c".repeat(40);
const currentRun = {
  id: 123,
  created_at: "2026-08-28T23:00:00Z",
  status: "in_progress",
  conclusion: null,
  head_sha: mainSha,
};
type WorkflowRun = Omit<typeof currentRun, "conclusion"> & { conclusion: string | null };

function runGate(runs: WorkflowRun[], options: { event?: string; workflowHeadSha?: string } = {}) {
  const workflow = parse(readFileSync(".github/workflows/docs-agent.yml", "utf8")) as {
    jobs: { "update-docs": { steps: Array<{ id?: string; run?: string }> } };
  };
  const gate = workflow.jobs["update-docs"].steps.find((step) => step.id === "gate");
  if (!gate?.run) {
    throw new Error("Docs Agent gate is missing");
  }

  const root = tempDirs.make("docs-agent-gate-");
  const bin = join(root, "bin");
  const output = join(root, "output");
  mkdirSync(bin);
  writeFileSync(output, "");
  const owner = join(root, "owner.py");
  copyFileSync(".github/actions/git-owner/owner.py", owner);
  // Only the gate runs. Git/network and the clock are fixtures; jq executes the real filters.
  const commands = {
    git: `if [ "$1" = "-C" ]; then shift 2; fi
case "$*" in
  'fetch --no-tags origin main') ;;
  'rev-parse origin/main'|'rev-parse HEAD') printf '%s\\n' '${mainSha}' ;;
  'rev-parse ${mainSha}^') printf '%s\\n' '${parentSha}' ;;
  'cat-file -e ${previousSha}^{commit}'|'cat-file -e ${parentSha}^{commit}') ;;
  *) printf 'Unexpected git call: %s\\n' "$*" >&2; exit 1 ;;
esac`,
    gh: `printf '%s\\n' "$DOCS_AGENT_RUNS_FIXTURE"`,
    date: `printf '%s\\n' '2026-08-28T22:30:00Z'`,
  };
  for (const [name, script] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", gate.run], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      RUNNER_TEMP: root,
      CI_GIT_OWNER: owner,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ID: String(currentRun.id),
      EVENT_NAME: options.event ?? "workflow_run",
      WORKFLOW_HEAD_SHA: options.workflowHeadSha ?? mainSha,
      DOCS_AGENT_RUNS_FIXTURE: JSON.stringify({ workflow_runs: runs }),
    },
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return { stdout: result.stdout, output: readFileSync(output, "utf8") };
}

function admittedOutput(reviewBase: string) {
  return [
    "run_agent=true",
    `base_sha=${mainSha}`,
    `review_base_sha=${reviewBase}`,
    `review_head_sha=${mainSha}`,
    "",
  ].join("\n");
}

describe.skipIf(process.platform === "win32")("Docs Agent gate", () => {
  it("retains both corrected REST selectors and the one-hour review ordering", () => {
    const source = readFileSync(".github/workflows/docs-agent.yml", "utf8");
    expect(source.match(/select\(\.id != \$current_run_id\)/gu)).toHaveLength(2);
    expect(
      source.match(/select\(\.conclusion != "cancelled" and \.conclusion != "skipped"\)/gu),
    ).toHaveLength(2);
    expect(source).not.toContain(".database_id");
    expect(source).toContain("date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ");
    expect(source).toContain("select(.created_at >= $one_hour_ago)");
    expect(source).toContain('| [.id, .status, (.conclusion // ""), .created_at, .head_sha]');
    expect(source).toContain("select(. != $remote_main)");
    expect(source).toContain('\' "$runs_json" | head -n 1');
  });

  it("does not let the current REST run throttle itself", () => {
    const result = runGate([currentRun]);
    expect(result.output).toBe(admittedOutput(parentSha));
    expect(result.stdout).not.toContain("skipping");
  });

  it.each([
    ["in progress", "in_progress", null],
    ["completed", "completed", "success"],
    ["failed", "completed", "failure"],
  ])("throttles another %s run and prints its REST id", (_label, status, conclusion) => {
    const other = { ...currentRun, id: 122, status, conclusion, head_sha: previousSha };
    const result = runGate([currentRun, other]);
    expect(result.output).toBe("run_agent=false\n");
    expect(result.stdout).toContain("already ran or is running within the last hour");
    expect(result.stdout).toContain(
      [other.id, status, conclusion ?? "", other.created_at, previousSha].join("\t"),
    );
    expect(result.stdout).not.toContain("123\t");
  });

  it("excludes the current id from the review base even with an older run snapshot", () => {
    const result = runGate([
      { ...currentRun, created_at: "2026-08-28T21:00:00Z", head_sha: parentSha },
      {
        ...currentRun,
        id: 122,
        created_at: "2026-08-28T20:00:00Z",
        status: "completed",
        conclusion: "success",
        head_sha: previousSha,
      },
    ]);
    expect(result.output).toBe(admittedOutput(previousSha));
  });

  it.each([
    ["skipped", currentRun.created_at],
    ["cancelled", currentRun.created_at],
    ["cancelled", "2026-08-28T22:29:59Z"],
  ])("ignores %s history from %s for cadence and review base", (conclusion, createdAt) => {
    const result = runGate([
      currentRun,
      {
        ...currentRun,
        id: 122,
        created_at: createdAt,
        status: "completed",
        conclusion,
        head_sha: parentSha,
      },
      {
        ...currentRun,
        id: 121,
        created_at: "2026-08-28T22:29:58Z",
        status: "completed",
        conclusion: "success",
        head_sha: previousSha,
      },
    ]);
    expect(result.output).toBe(admittedOutput(previousSha));
  });

  it("still rejects superseded CI", () => {
    const result = runGate([], { workflowHeadSha: previousSha });
    expect(result.output).toBe("run_agent=false\n");
    expect(result.stdout).toContain(`CI run is superseded by ${mainSha}`);
  });

  it("preserves manual dispatch admission without applying the hourly throttle", () => {
    const result = runGate([currentRun, { ...currentRun, id: 122 }], {
      event: "workflow_dispatch",
    });
    expect(result.output).toBe(admittedOutput(parentSha));
  });
});
