#!/usr/bin/env -S node --import tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isRetryableGhJsonErrorMessage } from "./ci-run-timings.mjs";
import { refitTestTimings, type CiTimingRun } from "./lib/ci-test-timings-refit.mts";
import { ciTestTimingsSchema } from "./lib/ci-test-timings-schema.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { execPlainGh } from "./lib/plain-gh.mjs";

const jobPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      conclusion: z.string().nullable(),
      labels: z.array(z.string()),
    }),
  ),
});

async function readGh(args: string[]): Promise<string> {
  const retryDelays = [1000, 3000, 6000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execPlainGh(args, {
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (
        attempt === retryDelays.length ||
        !isRetryableGhJsonErrorMessage(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      await setTimeout(retryDelays[attempt]);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      runs: { type: "string", default: "5" },
      repo: { type: "string", default: "openclaw/openclaw" },
      "dry-run": { type: "boolean", default: false },
      out: {
        type: "string",
        default: fileURLToPath(new URL("../config/ci-test-timings.json", import.meta.url)),
      },
    },
  });
  const count = parsePositiveInt(values.runs, "--runs");
  const repo = z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/u)
    .parse(values.repo);
  const runPageSchema = z.array(
    z.object({
      id: z.number().int().positive(),
      created_at: z.iso.datetime(),
      status: z.literal("completed"),
      conclusion: z.literal("success"),
      // A dispatch from main can check out target_ref; only push runs prove the measured ref.
      event: z.literal("push"),
      head_branch: z.literal("main"),
      head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
    }),
  );
  const listed: z.infer<typeof runPageSchema> = [];
  const pageSize = Math.min(count, 100);
  for (let page = 1; listed.length < count; page += 1) {
    if (page > 25) {
      throw new Error("Run pagination limit exceeded; reduce --runs");
    }
    const runs = runPageSchema.parse(
      JSON.parse(
        await readGh([
          "api",
          `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=${pageSize}&page=${page}`,
          "--jq",
          "[.workflow_runs[] | {id, created_at, status, conclusion, event, head_branch, head_sha}]",
        ]),
      ),
    );
    listed.push(...runs);
    if (runs.length < pageSize) {
      break;
    }
  }
  if (listed.length === 0) {
    throw new Error("No successful main CI runs found");
  }
  const releaseRunPageSchema = z.array(
    runPageSchema.element.extend({
      event: z.literal("workflow_dispatch"),
      head_branch: z.string().min(1),
    }),
  );
  const releaseRuns: z.infer<typeof releaseRunPageSchema> = [];
  // Full Release Validation freezes tooling on release-ci branches. These
  // workflows validate the canonical target before any Gateway test executes;
  // workflow head_sha is tooling identity, not the measured source identity.
  for (const workflow of [
    "openclaw-release-checks.yml",
    "openclaw-live-and-e2e-checks-reusable.yml",
  ]) {
    let sampled = 0;
    for (let page = 1; sampled < count; page += 1) {
      if (page > 25) {
        throw new Error("Release run pagination limit exceeded; reduce --runs");
      }
      const pageRuns = releaseRunPageSchema.parse(
        JSON.parse(
          await readGh([
            "api",
            `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&status=success&per_page=${pageSize}&page=${page}`,
            "--jq",
            "[.workflow_runs[] | {id, created_at, status, conclusion, event, head_branch, head_sha}]",
          ]),
        ),
      );
      releaseRuns.push(...pageRuns.slice(0, count - sampled));
      sampled += pageRuns.length;
      if (pageRuns.length < pageSize) {
        break;
      }
    }
  }
  // New gh versions reject reporter ANSI unless opted in; logs are parsed, never printed.
  const logFlags = (await readGh(["api", "--help"])).includes("--allow-escape-sequences")
    ? ["--allow-escape-sequences"]
    : [];
  const runs: CiTimingRun[] = [];
  const sampledRuns = [
    ...listed.slice(0, count).map((run) => ({ run, source: "ci" as const })),
    ...releaseRuns.map((run) => ({ run, source: "release" as const })),
  ];
  for (const { run, source } of sampledRuns) {
    const logs: CiTimingRun["logs"] = [];
    let seenJobs = 0;
    for (let page = 1; page <= 25; page += 1) {
      const payload = jobPageSchema.parse(
        JSON.parse(
          await readGh([
            "api",
            `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
            "--jq",
            "{total_count, jobs: [.jobs[] | {id, name, conclusion, labels}]}",
          ]),
        ),
      );
      for (const job of payload.jobs) {
        if (job.conclusion !== "success") {
          continue;
        }
        const kind =
          source === "release"
            ? /(?:^| \/ )Repo E2E \(Gateway \d+\/\d+\)$/u.test(job.name)
              ? "repoE2e"
              : undefined
            : job.name.startsWith("checks-ui-e2e (")
              ? "uiE2e"
              : job.name.startsWith("checks-node-compact-")
                ? "compact"
                : undefined;
        if (kind) {
          console.error(`[ci-timings] ${run.id}: ${job.name}`);
          logs.push({
            kind,
            labels: job.labels,
            text: await readGh(["api", `repos/${repo}/actions/jobs/${job.id}/logs`, ...logFlags]),
          });
        }
      }
      seenJobs += payload.jobs.length;
      if (seenJobs >= payload.total_count) {
        break;
      }
      if (payload.jobs.length === 0 || page === 25) {
        throw new Error(`Job pagination incomplete for CI run ${run.id}`);
      }
    }
    runs.push({ id: run.id, createdAt: run.created_at, logs });
  }
  let previous;
  try {
    previous = ciTestTimingsSchema.parse(JSON.parse(readFileSync(values.out, "utf8")));
  } catch {
    // A missing or invalid baseline has no measurements worth preserving.
  }
  const { timings, changes, runIds } = refitTestTimings(runs, previous);
  if (
    Object.keys(timings.uiE2e.fileSeconds).length +
      Object.keys(timings.repoE2eFileSeconds).length +
      Object.keys(timings.compactGroupSeconds.blacksmith).length +
      Object.keys(timings.compactGroupSeconds.github).length ===
    0
  ) {
    throw new Error("No test timings have at least two successful run samples");
  }
  ciTestTimingsSchema.parse(timings);
  console.log(`Sampled successful CI and release-check runs: ${runIds.join(", ")}\n`);
  console.log("| Key | Old seconds | New seconds | Delta |\n| --- | ---: | ---: | ---: |");
  for (const change of changes) {
    const delta =
      change.next === undefined
        ? "removed"
        : change.old === undefined || change.old === 0
          ? "new"
          : `${(((change.next - change.old) / change.old) * 100).toFixed(1)}%`;
    console.log(`| ${change.key} | ${change.old ?? "—"} | ${change.next ?? "—"} | ${delta} |`);
  }
  if (changes.length === 0) {
    console.log("\nNo timing changes exceed the 15% write threshold.");
  } else if (!values["dry-run"]) {
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(timings, null, 2)}\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[ci-timings] FAILED (exit 1)");
  process.exitCode = 1;
}
