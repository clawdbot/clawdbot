import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFindRunArgs,
  classifyAttachedCiRun,
  classifyRollup,
  classifyRunAttachment,
  collectRollupContexts,
  parseArgs,
  pollUntilDeadline,
  sanitizeCheckName,
  selectRunAfter,
} from "../../scripts/watch-pr-ci.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import placeholderFixture from "../fixtures/watch-pr-ci-queued-placeholder.json" with { type: "json" };

const sha = "a".repeat(40);

function runWatcher(
  ghScript: string,
  headSha = sha,
  options: string[] = [],
  clock: "poll" | "wall" = "poll",
) {
  return withTempDir("openclaw-watch-pr-ci-", async (binDir) => {
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, ghScript);
    chmodSync(ghPath, 0o755);
    const clockPath = join(binDir, "poll-clock.mjs");
    // Evidence fixtures advance polling only, independent of fake gh startup cost.
    // Deadline coverage explicitly retains the real clock and child timeout.
    // NODE_OPTIONS reaches the implementation through its unmodified CLI wrapper.
    writeFileSync(
      clockPath,
      `import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
if (process.argv[1] === ${JSON.stringify(fileURLToPath(new URL("../../scripts/watch-pr-ci.mts", import.meta.url)))}) {
  const now = ${clock === "wall" ? "Date.now" : "() => 0"};
  const realSleep = timers.setTimeout;
  let waitedMs = 0;
  Date.now = () => now() + waitedMs;
  timers.setTimeout = async (milliseconds, value, options) => {
    const result = await realSleep(0, value, options);
    waitedMs += milliseconds;
    return result;
  };
  syncBuiltinESMExports();
}
`,
    );
    return await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          [
            "scripts/watch-pr-ci.mjs",
            "42",
            headSha,
            "--attach-timeout",
            "1",
            "--timeout",
            "1",
            "--interval",
            "1",
            ...options,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(clockPath).href}`,
              PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
          (error, stdout, stderr) => {
            const exitCode = error ? error.code : 0;
            if (typeof exitCode !== "number") {
              reject(error);
              return;
            }
            resolve({ status: exitCode, stdout, stderr });
          },
        );
      },
    );
  });
}

function replayPlaceholder(
  fixture = structuredClone(placeholderFixture),
  evidence: {
    runSnapshots?: unknown[];
    runViewSnapshots?: unknown[];
    jobPages?: unknown[];
    directJobs?: unknown[];
    merged?: boolean;
    watchTimeout?: number;
    delayFirstAlias?: boolean;
    clock?: "poll" | "wall";
    afterAliasScan?: unknown;
  } = {},
) {
  return withTempDir("openclaw-watch-pr-ci-replay-", async (root) => {
    const payload = join(root, "payload.json");
    const calls = join(root, "calls.jsonl");
    // The live capture is merged. Only lifecycle is reopened for the historical watch.
    if (!evidence.merged) fixture.graphql.data.repository.pullRequest.state = "OPEN";
    writeFileSync(payload, JSON.stringify({ ...fixture, ...evidence }));
    writeFileSync(calls, "");
    const result = await runWatcher(
      `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, "utf8"));
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const runPath = "repos/openclaw/openclaw/actions/runs/33155056361";
const scanned = calls.some((call) => call[1]?.startsWith("repos/openclaw/openclaw/actions/jobs/"));
const currentGraphql = scanned && fixture.afterAliasScan !== undefined ? fixture.afterAliasScan : fixture.graphql;
let value;
if (args[0] === "pr" && args[1] === "view") value = currentGraphql.data.repository.pullRequest;
else if (args[0] === "run" && args[1] === "view") {
  const reads = calls.filter((call) => call[0] === "run" && call[1] === "view").length;
  value = fixture.runViewSnapshots?.[Math.min(reads, fixture.runViewSnapshots.length - 1)] ?? fixture.run;
}
else if (args[0] === "api" && args[1] === "graphql") value = currentGraphql;
else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) value = { workflow_runs: [fixture.run] };
else if (args[1] === runPath) {
  const reads = calls.filter((call) => call[1] === runPath).length;
  value = fixture.runSnapshots?.[Math.min(reads, fixture.runSnapshots.length - 1)] ?? fixture.run;
}
else if (args[1]?.startsWith(runPath + "/attempts/3/jobs?per_page=100&page=")) {
  const page = Number(new URLSearchParams(args[1].split("?")[1]).get("page"));
  value = (fixture.jobPages ?? [fixture.jobs])[page - 1];
  if (value === undefined) throw new Error("missing attempt jobs page");
}
else if (args[1]?.startsWith("repos/openclaw/openclaw/actions/jobs/")) {
  const jobIds = ${JSON.stringify(fixture.directJobs.map((job) => job.id))};
  const jobId = Number(args[1].split("/").at(-1));
  if (fixture.delayFirstAlias && jobId === jobIds[0]) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["slow-alias-completed"]) + "\\n");
  }
  value = fixture.directJobs[jobIds.indexOf(jobId)];
  if (value === undefined) throw new Error("missing direct job response");
}
else throw new Error("unexpected gh invocation: " + JSON.stringify(args));
console.log(JSON.stringify(value));
`,
      placeholderFixture.run.head_sha,
      evidence.watchTimeout === undefined
        ? []
        : ["--timeout", String(evidence.watchTimeout), "--interval", String(evidence.watchTimeout)],
      evidence.clock,
    );
    return { ...result, calls: readFileSync(calls, "utf8") };
  });
}

describe("watch-pr-ci", () => {
  it("parses defaults and overrides", () => {
    expect(parseArgs(["42", sha])).toEqual({
      pr: 42,
      headSha: sha,
      repo: "openclaw/openclaw",
      attachTimeout: 900,
      timeout: 3600,
      interval: 120,
      completion: "rollup",
    });
    expect(
      parseArgs([
        "7",
        sha,
        "--repo",
        "fork/project",
        "--after",
        "1234",
        "--attach-timeout",
        "30",
        "--timeout",
        "90",
        "--interval",
        "5",
        "--completion",
        "ci-run",
      ]),
    ).toMatchObject({
      repo: "fork/project",
      after: 1234,
      attachTimeout: 30,
      timeout: 90,
      interval: 5,
      completion: "ci-run",
    });
    expect(parseArgs(["1", sha.toUpperCase()]).headSha).toBe(sha);
  });

  it("rejects malformed arguments", () => {
    expect(() => parseArgs(["0", sha])).toThrow("pr-number must be a positive integer");
    expect(() => parseArgs(["1", "abc"])).toThrow("full 40-character commit SHA");
    expect(() => parseArgs(["1", sha, "--interval", "0"])).toThrow(
      "--interval must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--after", "0"])).toThrow(
      "--after must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--completion", "required"])).toThrow(
      "--completion must be rollup or ci-run",
    );
  });

  it("builds a pull-request-only run attachment query", () => {
    expect(buildFindRunArgs("openclaw/openclaw", sha)).toEqual([
      "api",
      "--method",
      "GET",
      "repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
      "-f",
      "event=pull_request",
      "-f",
      `head_sha=${sha}`,
      "-f",
      "per_page=20",
    ]);
  });

  it("filters run ids at and before --after", () => {
    const newer = { id: 102, created_at: "2026-07-23T02:00:00Z" };
    const runs = [newer, { id: 101, created_at: "2026-07-23T01:00:00Z" }];
    expect(selectRunAfter(runs, 101)).toBe(newer);
    expect(selectRunAfter(runs, 102)).toBeUndefined();
    expect(selectRunAfter(runs)).toBe(newer);
  });

  it("skips newer draft runs without weakening the --after boundary", () => {
    const skipped = { id: 103, conclusion: "skipped" };
    const successful = { id: 102, conclusion: "success" };

    expect(selectRunAfter([skipped, successful])).toBe(successful);
    expect(selectRunAfter([skipped, successful], 101)).toBe(successful);
    expect(selectRunAfter([skipped, successful], 102)).toBeUndefined();
    expect(selectRunAfter([skipped])).toBeUndefined();
    for (const conclusion of [null, "failure", "cancelled"]) {
      const attachable = { id: 102, conclusion };
      expect(selectRunAfter([skipped, attachable])).toBe(attachable);
    }
  });

  it.skipIf(process.platform === "win32")(
    "attaches to real CI when a newer draft workflow was skipped",
    async () => {
      const result = await runWatcher(
        `#!/usr/bin/env bash
case "$1 $2" in
  "pr view") printf '{"state":"OPEN","mergeable":true,"headRefOid":"${sha}"}\\n' ;;
  "api --method")
    case " $* " in
      *" per_page=1 "*) printf '{"workflow_runs":[{"id":202,"conclusion":"skipped"}]}\\n' ;;
      *) printf '{"workflow_runs":[{"id":202,"conclusion":"skipped"},{"id":201,"conclusion":"success"}]}\\n' ;;
    esac
    ;;
  "run view")
    if [ "$3" = "202" ]; then
      printf '{"status":"completed","conclusion":"skipped"}\\n'
    else
      printf '{"status":"completed","conclusion":"success"}\\n'
    fi
    ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
        sha,
        ["--completion", "ci-run"],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("ATTACHED run=201");
      expect(result.stdout).toContain("GREEN");
    },
  );

  describe.skipIf(process.platform === "win32")("queued placeholder CLI evidence", () => {
    it.each([
      { state: "FAILURE", observed: 1 },
      { state: "PENDING", observed: 1 },
      { state: "FAILURE", observed: 2 },
    ])(
      "reconciles the captured queued group with aggregate $state and $observed observed checks",
      async ({ state, observed }) => {
        const fixture = structuredClone(placeholderFixture);
        const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
        rollup.state = state;
        if (observed === 2) {
          // Synthetic visibility of another captured alias proves group reads are shared.
          const queuedCheck = rollup.contexts.nodes.find(
            (check) => check.databaseId === 98802098786,
          );
          assert(queuedCheck);
          rollup.contexts.nodes.push({ ...queuedCheck, databaseId: 98802098559 });
          rollup.contexts.totalCount += 1;
        }
        const result = await replayPlaceholder(fixture, { watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain(`pending=0 superseded=${observed}`);
        expect(result.stdout).toContain("GREEN");
        // Cost and ordering matter: direct proof precedes run revalidation and
        // a fresh PR snapshot, followed by the ordinary final CI-run check.
        const calls: string[][] = result.calls
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call[1]?.includes("/attempts/"))).toHaveLength(1);
        const directReads = calls.filter((call) => call[1]?.includes("/actions/jobs/"));
        expect(directReads.map((call) => Number(call[1]?.split("/").at(-1))).toSorted()).toEqual(
          fixture.directJobs.map((job) => job.id).toSorted(),
        );
        const finalEvidenceRead = calls.findLastIndex(
          (call) => call[1] === "repos/openclaw/openclaw/actions/runs/33155056361",
        );
        expect(finalEvidenceRead).toBeGreaterThan(
          calls.findLastIndex((call) => call[1]?.includes("/actions/jobs/")),
        );
        expect(calls[finalEvidenceRead]).toContain("Cache-Control: max-age=0");
        expect(calls.findLastIndex((call) => call[1] === "graphql")).toBeGreaterThan(
          finalEvidenceRead,
        );
        expect(calls.at(-1)?.slice(0, 2)).toEqual(["run", "view"]);
      },
    );

    it.each([
      { aliasCount: 32, exitCode: 0 },
      { aliasCount: 33, exitCode: 16 },
    ])(
      "bounds direct verification of a $aliasCount-alias group",
      async ({ aliasCount, exitCode }) => {
        const fixture = structuredClone(placeholderFixture);
        const alias = fixture.directJobs[0];
        assert(alias);
        for (let index = fixture.directJobs.length; index < aliasCount; index += 1) {
          const extra = { ...alias, id: 1_000_000 + index };
          fixture.jobs.jobs.push(extra);
          fixture.directJobs.push(extra);
        }
        fixture.jobs.total_count = fixture.jobs.jobs.length;
        const result = await replayPlaceholder(fixture, { watchTimeout: exitCode === 0 ? 5 : 1 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        const calls: string[][] = result.calls
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const directReads = calls.filter((call) => call[1]?.includes("/actions/jobs/"));
        expect(directReads).toHaveLength(exitCode === 0 ? aliasCount : 0);
        if (exitCode !== 0) {
          expect(result.stdout).toContain("pending=1");
          expect(result.stdout).not.toContain("GREEN");
        }
      },
    );

    it("bounds a slow alias read by the remaining watcher deadline", async () => {
      const result = await replayPlaceholder(structuredClone(placeholderFixture), {
        delayFirstAlias: true,
        clock: "wall",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("pending=1");
      expect(result.stdout).not.toContain("GREEN");
      const calls: string[][] = result.calls
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((call) => call[1]?.includes("/actions/jobs/"))).toHaveLength(1);
      expect(result.calls).not.toContain('"slow-alias-completed"');
    });

    it.each([
      {
        label: "moved head",
        patch: { headRefOid: sha, statusCheckRollup: null },
        exitCode: 11,
        output: "HEAD-MOVED",
      },
      { label: "closed PR", patch: { state: "CLOSED" }, exitCode: 10, output: "PR-CLOSED" },
      {
        label: "conflicting PR",
        patch: { mergeable: false },
        exitCode: 14,
        output: "CONFLICTING-MID-WAIT",
      },
    ])("rechecks a $label after alias verification", async ({ patch, exitCode, output }) => {
      const fixture = structuredClone(placeholderFixture);
      const afterAliasScan = structuredClone(fixture.graphql);
      afterAliasScan.data.repository.pullRequest.state = "OPEN";
      Object.assign(afterAliasScan.data.repository.pullRequest, patch);
      const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).toContain(output);
      expect(result.stdout).not.toContain("GREEN");
    });

    it.each([
      { label: "pending", status: "QUEUED", conclusion: null, exitCode: 16 },
      { label: "failed", status: "COMPLETED", conclusion: "FAILURE", exitCode: 15 },
    ])(
      "observes a new $label required check after alias verification",
      async ({ status, conclusion, exitCode }) => {
        const fixture = structuredClone(placeholderFixture);
        const afterAliasScan = structuredClone(fixture.graphql);
        afterAliasScan.data.repository.pullRequest.state = "OPEN";
        const contexts = afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts;
        Object.assign(contexts, {
          totalCount: contexts.totalCount + 1,
          nodes: [
            ...contexts.nodes,
            { kind: "CheckRun", name: "new required check", status, conclusion },
          ],
        });
        const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).not.toContain("GREEN");
      },
    );

    it.each([
      { label: "starts running", patch: { status: "IN_PROGRESS" }, exitCode: 16 },
      { label: "fails", patch: { status: "COMPLETED", conclusion: "FAILURE" }, exitCode: 15 },
      {
        label: "loses its conclusion",
        patch: { status: "COMPLETED", conclusion: null },
        exitCode: 16,
      },
      { label: "is renamed", patch: { name: "different required check" }, exitCode: 16 },
    ])("does not reuse proof when an alias $label", async ({ patch, exitCode }) => {
      const fixture = structuredClone(placeholderFixture);
      const afterAliasScan = structuredClone(fixture.graphql);
      afterAliasScan.data.repository.pullRequest.state = "OPEN";
      const alias =
        afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts.nodes.find(
          (check) => check.databaseId === 98802098786,
        );
      assert(alias);
      Object.assign(alias, patch);
      const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).not.toContain("GREEN");
    });

    it.each(
      [
        { status: "IN_PROGRESS", conclusion: null, exitCode: 16 },
        { status: "COMPLETED", conclusion: "FAILURE", exitCode: 15 },
      ].flatMap((outcome) =>
        [false, true].map((initiallyVisible) => ({ ...outcome, initiallyVisible })),
      ),
    )(
      "keeps a changed lower-ID alias blocking ($status, initially visible: $initiallyVisible)",
      async ({ status, conclusion, exitCode, initiallyVisible }) => {
        const fixture = structuredClone(placeholderFixture);
        const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
        const queued = contexts.nodes.find((check) => check.databaseId === 98802098786);
        assert(queued);
        const lower = { ...queued, databaseId: 98802098559 };
        if (initiallyVisible) {
          contexts.nodes.push(lower);
          contexts.totalCount += 1;
        }
        const afterAliasScan = structuredClone(fixture.graphql);
        afterAliasScan.data.repository.pullRequest.state = "OPEN";
        const refreshed = afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts;
        if (!initiallyVisible) {
          refreshed.nodes.push(lower);
          refreshed.totalCount += 1;
        }
        const changed = refreshed.nodes.find((check) => check.databaseId === lower.databaseId);
        assert(changed);
        Object.assign(changed, { status, conclusion });
        const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).not.toContain("GREEN");
      },
    );

    it.each([33155056361, 33155056360])(
      "still supersedes an older failed check from run %s",
      async (runId) => {
        const fixture = structuredClone(placeholderFixture);
        const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
        const queued = contexts.nodes.find((check) => check.databaseId === 98802098786);
        assert(queued);
        const older = structuredClone(queued);
        Object.assign(older, {
          databaseId: 98790000000,
          status: "COMPLETED",
          conclusion: "FAILURE",
        });
        older.checkSuite.workflowRun.databaseId = runId;
        contexts.nodes.push(older);
        contexts.totalCount += 1;
        const result = await replayPlaceholder(fixture, { watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("GREEN");
      },
    );

    it("rechecks the attached run after refreshing the PR snapshot", async () => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        runViewSnapshots: [fixture.run, fixture.run, { status: "in_progress", conclusion: null }],
        watchTimeout: 5,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
    });

    it("keeps the captured merged PR closed", async () => {
      const result = await replayPlaceholder(structuredClone(placeholderFixture), { merged: true });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(10);
      expect(result.stdout).toContain("PR-CLOSED state=MERGED");
      expect(result.calls).not.toContain("/actions/");
    });

    it.each([
      ["no same-name replacement", { name: "different job" }],
      ["active replacement", { status: "in_progress", conclusion: null }],
      ["failed replacement", { conclusion: "failure" }],
      ["unexecuted replacement", { runner_id: null, steps: [] }],
      ["another attempt", { run_attempt: 2 }],
      ["another run", { run_id: 33155056362 }],
      ["another head", { head_sha: sha }],
      ["missing attempt", { run_attempt: undefined }],
    ])("keeps pending for %s in the attempt list", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      Object.assign(
        fixture.jobs.jobs.find((job) => job.id === 98802098754)!,
        patch,
      );
      const result = await replayPlaceholder(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain("/attempts/3/jobs?per_page=100&page=1");
    });

    // Independent rejection fixtures keep their own CLI process and clock state.
    // Keep successful scans and short-deadline job scans serial.
    it.concurrent.each([
      ["assigned queued job", { runner_id: 123 }],
      ["executed steps", { steps: [{ status: "completed", conclusion: "success" }] }],
      ["missing steps", { steps: undefined }],
      ["missing runner", { runner_id: undefined }],
      ["different check ID", { id: 98802098787 }],
      ["different name", { name: "different job" }],
      ["different run", { run_id: 33155056362 }],
      ["different head", { head_sha: sha }],
      ["different attempt", { run_attempt: 4 }],
      ["active job", { status: "in_progress" }],
      ["failed job", { conclusion: "failure" }],
    ])("requires direct unexecuted-job proof: %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        watchTimeout: 5,
        directJobs: fixture.directJobs.map((job) =>
          job.id === 98802098786 ? { ...job, ...patch } : job,
        ),
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain('"repos/openclaw/openclaw/actions/jobs/98802098786"');
    });

    it.each([
      ["executed", { steps: [{ status: "completed", conclusion: "success" }] }],
      ["active", { status: "in_progress", runner_id: 123 }],
      ["failed", { status: "completed", conclusion: "failure" }],
      ["malformed", { run_attempt: undefined }],
    ])("keeps the group pending when a non-rollup sibling is %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        directJobs: fixture.directJobs.map((job) =>
          job.id === 98802098559 ? { ...job, ...patch } : job,
        ),
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain('"repos/openclaw/openclaw/actions/jobs/98802098559"');
    });

    it.concurrent.each([
      ["missing ID", { id: undefined }],
      ["missing head", { head_sha: undefined }],
      ["missing workflow", { workflow_id: undefined }],
      ["missing attempt", { run_attempt: undefined }],
      ["different workflow", { workflow_id: 1 }],
      ["different workflow path", { path: ".github/workflows/other.yml" }],
      ["different head", { head_sha: sha }],
      ["different run", { id: 33155056362 }],
      ["active newer attempt", { run_attempt: 4, status: "in_progress", conclusion: null }],
      ["failed newer attempt", { run_attempt: 4, conclusion: "failure" }],
      ["cancelled newer attempt", { run_attempt: 4, conclusion: "cancelled" }],
      ["successful newer attempt", { run_attempt: 4 }],
    ])("rejects changed run evidence after collecting jobs: %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        watchTimeout: 5,
        runSnapshots: [fixture.run, { ...fixture.run, ...patch }],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      const runReads = result.calls
        .split("\n")
        .filter((call) => call.includes('"repos/openclaw/openclaw/actions/runs/33155056361"'));
      expect(runReads.length).toBeGreaterThanOrEqual(2);
    });

    it.concurrent.each([
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "success" },
    ])(
      "does not ignore an extra $status/$conclusion same-name sibling",
      async ({ status, conclusion }) => {
        const fixture = structuredClone(placeholderFixture);
        const replacement = fixture.jobs.jobs.find((job) => job.id === 98802098754);
        assert(replacement);
        const result = await replayPlaceholder(fixture, {
          jobPages: [
            {
              total_count: fixture.jobs.total_count + 1,
              jobs: [...fixture.jobs.jobs, { ...replacement, id: 98802098799, status, conclusion }],
            },
          ],
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
        expect(result.calls).toContain("/attempts/3/jobs?per_page=100&page=1");
      },
    );

    it.concurrent.each([
      [
        "unrelated workflow",
        { checkSuite: { workflowRun: { databaseId: 33155056361, workflow: { databaseId: 1 } } } },
      ],
      [
        "unrelated run",
        {
          checkSuite: {
            workflowRun: { databaseId: 33155056362, workflow: { databaseId: 209874334 } },
          },
        },
      ],
      ["missing check ID", { databaseId: undefined }],
      ["App check without lineage", { checkSuite: undefined }],
      ["in-progress check", { status: "IN_PROGRESS" }],
      [
        "required status context",
        { kind: "StatusContext", context: "required status", state: "PENDING" },
      ],
    ])("does not reconcile %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const queuedCheck =
        fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts.nodes.find(
          (check) => check.databaseId === 98802098786,
        );
      assert(queuedCheck);
      Object.assign(queuedCheck, patch);
      const result = await replayPlaceholder(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.calls).not.toContain("/attempts/");
      expect(result.calls).toContain('["api","graphql",');
    });

    it.concurrent.each([
      [
        "pending required App check",
        { kind: "CheckRun", name: "required App", status: "QUEUED" },
        16,
      ],
      [
        "failed required App check",
        { kind: "CheckRun", name: "required App", status: "COMPLETED", conclusion: "FAILURE" },
        15,
      ],
      [
        "pending required status context",
        { kind: "StatusContext", context: "required status", state: "EXPECTED" },
        16,
      ],
      [
        "failed required status context",
        { kind: "StatusContext", context: "required status", state: "FAILURE" },
        15,
      ],
      [
        "unknown completed conclusion",
        { kind: "CheckRun", name: "required App", status: "COMPLETED" },
        16,
      ],
    ] as const)("keeps %s independently blocking", async (_label, sibling, exitCode) => {
      const fixture = structuredClone(placeholderFixture);
      const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
      // Synthetic counterexamples add a separate, lineage-less required context.
      Object.assign(contexts, {
        totalCount: contexts.totalCount + 1,
        nodes: [...contexts.nodes, sibling],
      });
      const result = await replayPlaceholder(fixture, { watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).not.toContain("GREEN");
      if (exitCode === 16) expect(result.stdout).toContain("superseded=1");
    });

    it.concurrent.each(["unknown", "truncated", "unfinished pagination", "missing count"])(
      "does not green an %s rollup",
      async (scenario) => {
        const fixture = structuredClone(placeholderFixture);
        const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
        if (scenario === "unknown") rollup.state = "UNKNOWN";
        else if (scenario === "truncated") rollup.contexts.totalCount += 1;
        else if (scenario === "missing count")
          Object.assign(rollup.contexts, { totalCount: undefined });
        else rollup.contexts.pageInfo.hasNextPage = true;
        const result = await replayPlaceholder(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
        expect(result.stdout).not.toContain("GREEN");
        expect(result.calls).not.toContain("/attempts/");
        expect(result.calls).toContain('["api","graphql",');
      },
    );

    it.each(["in_progress", "queued", "completed"])(
      "avoids evidence scans on routine %s polls",
      async (status) => {
        const fixture = structuredClone(placeholderFixture);
        fixture.run.status = status;
        if (status === "completed") {
          const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
          rollup.state = "SUCCESS";
          rollup.contexts.nodes = rollup.contexts.nodes.slice(0, 1);
          rollup.contexts.totalCount = 1;
        }
        const result = await replayPlaceholder(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          status === "completed" ? 0 : 16,
        );
        expect(result.calls).not.toContain("/attempts/");
        expect(result.calls).not.toContain("/actions/jobs/");
      },
    );

    it.each(["complete", "missing page", "changed count", "duplicate IDs", "over limit"])(
      "requires complete bounded attempt pagination: %s",
      async (scenario) => {
        const fixture = structuredClone(placeholderFixture);
        // Synthetic pagination padding from the captured successful sibling; IDs/names
        // are deliberately unique so the target group only appears on the second page.
        const padding = Array.from({ length: 100 }, (_, index) => ({
          ...fixture.jobs.jobs.find((job) => job.id === 98802098742)!,
          id: scenario === "duplicate IDs" ? 1_000 : 1_000 + index,
          name: `pagination sibling ${index}`,
        }));
        const firstPage = { total_count: 100 + fixture.jobs.total_count, jobs: padding };
        const lastPage = { total_count: firstPage.total_count, jobs: fixture.jobs.jobs };
        const jobPages = [firstPage, lastPage];
        if (scenario === "missing page") jobPages.pop();
        if (scenario === "changed count") lastPage.total_count += 1;
        if (scenario === "over limit") firstPage.total_count = 1_001;
        const result = await replayPlaceholder(fixture, {
          jobPages,
          watchTimeout: scenario === "complete" ? 5 : 1,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          scenario === "complete" ? 0 : 16,
        );
        if (scenario === "complete") expect(result.calls).toContain("per_page=100&page=2");
      },
    );
  });

  it("sanitizes untrusted check names for terminal output", () => {
    expect(sanitizeCheckName("plain ASCII / check (1)")).toBe("plain ASCII / check (1)");
    expect(sanitizeCheckName("Crème 日本語 １２３")).toBe("Crème 日本語 １２３");
    expect(sanitizeCheckName("unit\n\r\t\u0000check")).toBe("unit?check");
    expect(sanitizeCheckName("safe\u001b[31mred\u001b[0m text")).toBe("safe?red? text");
    expect(sanitizeCheckName("link\u001b]8;;https://example.com\u0007text\u001b]8;;\u0007")).toBe(
      "link?text?",
    );
    expect(sanitizeCheckName("left\u202Eright 😀")).toBe("left?right ?");
  });

  it("sanitizes failing check and status-context names before classification output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "unit\u001b[31mowned\u001b[0m",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
            { kind: "StatusContext", context: "deploy\nprod", state: "ERROR" },
          ],
        },
      }).failingNames,
    ).toEqual(["deploy?prod", "unit?owned?"]);
  });

  it("polls once more after the deadline-clamped final wait", async () => {
    let now = 0;
    const waits: number[] = [];
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      poll: () => (++polls === 2 ? "transitioned" : undefined),
    });

    expect(result).toBe("transitioned");
    expect(waits).toEqual([1_000]);
    expect(polls).toBe(2);
  });

  it("times out only after polling at the deadline", async () => {
    let now = 0;
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      poll: () => {
        polls += 1;
        return undefined;
      },
    });

    expect(result).toBeUndefined();
    expect(now).toBe(1_000);
    expect(polls).toBe(2);
  });

  it("warns for an already-completed late attachment without changing attachment", () => {
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" })).toEqual({
      attach: true,
      warning:
        "WARN attaching to already-completed run 102 (started before watcher); pass --after 102 to require a fresh run",
    });
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" }, 101)).toEqual(
      { attach: true, warning: undefined },
    );
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "skipped" })).toEqual({
      attach: false,
    });
  });

  it("requires aggregate success for a green rollup", () => {
    expect(classifyRollup({ state: "SUCCESS", contexts: { nodes: [] } }).verdict).toBe("GREEN");
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 0, failingNames: [], supersededCount: 0 });
  });

  it("counts pending contexts without deriving the verdict from them", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "IN_PROGRESS", conclusion: null }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 0 });
  });

  it("lets an attached successful CI run finish while an optional context remains pending", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "optional proof", status: "IN_PROGRESS", conclusion: null },
          ],
        },
      }).verdict,
    ).toBe("PENDING");
    expect(classifyAttachedCiRun({ status: "completed", conclusion: "success" })).toEqual({
      verdict: "GREEN",
    });
  });

  it.each(["FAILURE", "ERROR"])(
    "keeps identity-less same-name cancellations failing for aggregate %s",
    (state) => {
      expect(
        classifyRollup({
          state,
          contexts: {
            totalCount: 3,
            nodes: [
              {
                kind: "CheckRun",
                name: "Auto response",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          },
        }),
      ).toEqual({
        verdict: "FAILING",
        pendingCount: 0,
        failingNames: ["unit"],
        supersededCount: 0,
      });
    },
  );

  it("keeps a truncated failing rollup failing", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 4,
          nodes: [
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit", "+2 more contexts not shown"],
      supersededCount: 0,
    });
  });

  it("keeps cancelled attempts in failing-name output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "Auto response", status: "COMPLETED", conclusion: "FAILURE" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            { kind: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["lint", "unit"],
      supersededCount: 0,
    });
  });

  it("ignores superseded workflow runs while replacements are in progress", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 2, failingNames: [], supersededCount: 1 });
  });

  it.each<{
    label: string;
    name?: string;
    conclusion?: string;
    event?: string | null;
    workflowId?: number | null;
    newerRunId?: number;
    newerWorkflowId?: number | null;
    ciStatus?: string;
    verdict?: string;
  }>([
    { label: "pending CI", ciStatus: "IN_PROGRESS", verdict: "PENDING" },
    { label: "successful CI with a different check name", name: "target guard", verdict: "GREEN" },
    { label: "latest target cancellation", newerRunId: 100 },
    { label: "real target failure", conclusion: "FAILURE" },
    { label: "another event's cancellation", event: "pull_request" },
    { label: "another workflow", newerWorkflowId: 20 },
    { label: "unknown event", event: null },
    { label: "unknown visible workflow identity", workflowId: null },
    { label: "unknown replacement workflow identity", newerWorkflowId: null },
  ])(
    "uses newer same-workflow target-run identity without hiding $label",
    ({
      name = "dispatch",
      conclusion = "CANCELLED",
      event = "pull_request_target",
      workflowId = 10,
      newerRunId = 200,
      newerWorkflowId = 10,
      ciStatus = "COMPLETED",
      verdict = "FAILING",
    }) => {
      expect(
        classifyRollup(
          {
            state: "FAILURE",
            contexts: {
              nodes: [
                {
                  kind: "CheckRun",
                  name,
                  status: "COMPLETED",
                  conclusion,
                  checkSuite: {
                    workflowRun: {
                      databaseId: 100,
                      event: event ?? undefined,
                      workflow: { databaseId: workflowId ?? undefined },
                    },
                  },
                },
                {
                  kind: "CheckRun",
                  name: "CI",
                  status: ciStatus,
                  conclusion: ciStatus === "COMPLETED" ? "SUCCESS" : null,
                  checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
                },
              ],
            },
          },
          [{ id: newerRunId, workflow_id: newerWorkflowId ?? undefined }],
        ),
      ).toEqual({
        verdict,
        pendingCount: ciStatus === "IN_PROGRESS" ? 1 : 0,
        failingNames: verdict === "FAILING" ? [name] : [],
        supersededCount: verdict === "FAILING" ? 0 : 1,
      });
    },
  );

  it("keeps only the newest same-run check attempt while its replacement is pending", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 1 });
  });

  it("accepts a successful newest check attempt when the aggregate remains failed", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("accepts newest successful runs when the aggregate remains failed", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old proof",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "proof",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "old CI",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 250, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 2 });
  });

  it("preserves a genuine failure from the newest workflow run", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "superseded cancellation",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit"],
      supersededCount: 1,
    });
  });

  it("preserves failures across interleaved distinct workflow identities", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old deploy",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 10 } } },
            },
            {
              kind: "CheckRun",
              name: "deploy",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit"],
      supersededCount: 1,
    });
  });

  it("keeps an older run's unique failing job visible", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "nightly-special",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["nightly-special"],
      supersededCount: 0,
    });
  });

  it("supersedes same-name checks across runs of the same workflow", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("fails conservatively when unseen contexts may explain aggregate failure", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 3,
          nodes: [
            {
              kind: "CheckRun",
              name: "old CI",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["status rollup", "+1 more contexts not shown"],
      supersededCount: 1,
    });
  });

  it("collects rollup contexts across pages", () => {
    const cursors: Array<string | null> = [];
    const result = collectRollupContexts((cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        return {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              totalCount: 2,
              nodes: [{ kind: "CheckRun", name: "first" }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        };
      }
      return {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: 2,
            nodes: [{ kind: "CheckRun", name: "second" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    expect(cursors).toEqual([null, "next"]);
    expect(result?.statusCheckRollup?.contexts?.totalCount).toBe(2);
    expect(result?.statusCheckRollup?.contexts?.nodes?.map((node) => node.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects rollup pages from a changed snapshot", () => {
    expect(() =>
      collectRollupContexts((cursor) => ({
        headRefOid: "a".repeat(40),
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: cursor === null ? 2 : 3,
            nodes: [{ kind: "CheckRun", name: cursor === null ? "first" : "second" }],
            pageInfo:
              cursor === null
                ? { hasNextPage: true, endCursor: "next" }
                : { hasNextPage: false, endCursor: null },
          },
        },
      })),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("rejects a pagination read that loses an advertised page", () => {
    expect(() =>
      collectRollupContexts((cursor) =>
        cursor === null
          ? {
              headRefOid: "a".repeat(40),
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  totalCount: 2,
                  nodes: [{ kind: "CheckRun", name: "first" }],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            }
          : { headRefOid: "b".repeat(40), statusCheckRollup: null },
      ),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("caps rollup context collection at ten pages", () => {
    let calls = 0;
    const result = collectRollupContexts(() => {
      calls += 1;
      return {
        statusCheckRollup: {
          state: "FAILURE",
          contexts: {
            totalCount: 11,
            nodes: [{ kind: "CheckRun", name: `page-${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
          },
        },
      };
    });

    expect(calls).toBe(10);
    expect(result?.statusCheckRollup?.contexts?.nodes).toHaveLength(10);
  });
});
