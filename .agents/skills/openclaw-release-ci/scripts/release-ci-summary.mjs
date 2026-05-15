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
const runList = gh([
  "api",
  `repos/${repo}/actions/runs?per_page=100`,
  "--jq",
  `.workflow_runs[] | select(.created_at >= "${since}") | select(.name=="CI" or .name=="OpenClaw Release Checks" or .name=="Plugin Prerelease" or .name=="NPM Telegram Beta E2E" or .name=="Full Release Validation") | [.id,.name,.status,.conclusion,.head_sha,.html_url] | @tsv`,
]).trim();

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
