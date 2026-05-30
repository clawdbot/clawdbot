#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

const runId = process.argv[2];
const repo = process.env.OPENCLAW_RELEASE_REPO || "openclaw/openclaw";

if (!runId) {
  console.error("usage: release-ci-summary.mjs <full-release-run-id>");
  process.exit(2);
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function jsonGh(args) {
  return JSON.parse(gh(args));
}

function githubRestJson(pathSuffix) {
  const result = execFileSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        'token="$(gh auth token)"',
        'curl -fsS -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "${OPENCLAW_GITHUB_REST_URL}"',
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_GITHUB_REST_URL: `https://api.github.com/repos/${repo}/${pathSuffix}`,
      },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(result);
}

function rate() {
  try {
    return jsonGh(["api", "rate_limit"]).resources.core;
  } catch {
    return undefined;
  }
}

const core = rate();
if (core) {
  const reset = new Date(core.reset * 1000).toISOString();
  console.log(`rate: remaining=${core.remaining}/${core.limit} reset=${reset}`);
  if (core.remaining < 20) {
    console.error("rate too low for CI summary; wait for reset before polling");
    process.exit(3);
  }
}

const parent = jsonGh([
  "run",
  "view",
  runId,
  "--repo",
  repo,
  "--json",
  "status,conclusion,createdAt,headSha,url,jobs",
]);

console.log(`parent: ${runId} ${parent.status}/${parent.conclusion || "none"}`);
console.log(`sha: ${parent.headSha}`);
console.log(`url: ${parent.url}`);

for (const job of parent.jobs ?? []) {
  const marker = job.conclusion || job.status;
  console.log(`parent-job: ${marker} ${job.name}`);
}

const since = parent.createdAt;
const runsQuery = new URLSearchParams({
  per_page: "100",
  created: `>=${since}`,
  exclude_pull_requests: "true",
});
const childWorkflowNames = new Set([
  "CI",
  "OpenClaw Release Checks",
  "Plugin Prerelease",
  "NPM Telegram Beta E2E",
  "Full Release Validation",
]);
const runs = githubRestJson(`actions/runs?${runsQuery.toString()}`).workflow_runs ?? [];
const runList = runs
  .filter(
    (run) =>
      run.created_at >= since &&
      run.head_sha === parent.headSha &&
      childWorkflowNames.has(run.name),
  )
  .map((run) =>
    [run.id, run.name, run.status, run.conclusion ?? "", run.head_sha, run.html_url].join("\t"),
  )
  .join("\n");

if (!runList) {
  console.log("children: none found yet");
  process.exit(0);
}

console.log("children:");
for (const line of runList.split("\n")) {
  const [id, name, status, conclusion, sha, url] = line.split("\t");
  console.log(`child: ${id} ${name} ${status}/${conclusion || "none"} sha=${sha}`);
  console.log(`child-url: ${url}`);
}
