#!/usr/bin/env node
// Alerts when the openclaw/docs mirror is stale relative to docs-touching
// commits on main. Reads the watched paths from docs-sync-publish.yml itself so
// the staleness definition can never drift from the sync trigger's path filters.
// On staleness it dispatches one recovery sync, then exits nonzero so the
// scheduled run fails and notifies. Runner: .github/workflows/docs-mirror-freshness.yml.

import fs from "node:fs";
import process from "node:process";

const TOOL = "docs-mirror-freshness";
const SOURCE_REPO = process.env.GITHUB_REPOSITORY || "openclaw/openclaw";
// Publish-repo contract: docs mirror to openclaw/docs (root AGENTS.md, Docs section).
const MIRROR_REPO = "openclaw/docs";
const SYNC_WORKFLOW = "docs-sync-publish.yml";
const SYNC_WORKFLOW_FILE = `.github/workflows/${SYNC_WORKFLOW}`;
const STALE_MINUTES = Number(process.env.DOCS_MIRROR_STALE_MINUTES ?? "60");

function fail(message) {
  console.error(message);
  console.error(`[${TOOL}] FAILED (exit 1)`);
  process.exit(1);
}

async function githubJson(apiPath, init = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": TOOL,
    ...init.headers,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com${apiPath}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? "GET"} ${apiPath} responded ${response.status}`);
  }
  return response.status === 204 ? null : await response.json();
}

function readSyncWatchPaths(workflowText) {
  const paths = [];
  let inPush = false;
  let inPaths = false;
  for (const line of workflowText.split("\n")) {
    if (/^ {2}push:\s*$/.test(line)) {
      inPush = true;
      continue;
    }
    if (inPush && /^ {0,2}\S/.test(line)) {
      inPush = false;
      inPaths = false;
    }
    if (inPush && /^ {4}paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = line.match(/^\s+-\s+(\S+)\s*$/);
      if (item) {
        paths.push(item[1]);
        continue;
      }
      inPaths = false;
    }
  }
  if (paths.length === 0) {
    throw new Error(
      `no push path filters parsed from ${SYNC_WORKFLOW_FILE}; parser needs updating`,
    );
  }
  return paths;
}

// The commits API takes plain file/directory paths, so only the trailing-glob
// directory form used by the sync trigger is translatable; any other glob means
// the filter shape changed and this check must be updated, not silently skipped.
function toCommitApiPath(pattern) {
  const bare = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  if (/[*?[\]]/.test(bare)) {
    throw new Error(`unsupported glob in sync path filter: ${pattern}`);
  }
  return bare;
}

async function newestWatchedCommit(watchPaths) {
  let newest = null;
  for (const watchPath of watchPaths) {
    const commits = await githubJson(
      `/repos/${SOURCE_REPO}/commits?sha=main&path=${encodeURIComponent(watchPath)}&per_page=1`,
    );
    const head = commits[0];
    if (!head) {
      continue;
    }
    const committedAt = Date.parse(head.commit.committer.date);
    if (!newest || committedAt > newest.committedAt) {
      newest = { sha: head.sha, committedAt, path: watchPath };
    }
  }
  if (!newest) {
    throw new Error("no commits found for any watched docs path on main");
  }
  return newest;
}

async function readMirroredSourceSha() {
  const contents = await githubJson(
    `/repos/${MIRROR_REPO}/contents/.openclaw-sync/source.json?ref=main`,
  );
  const source = JSON.parse(Buffer.from(contents.content, "base64").toString("utf8"));
  if (typeof source.sha !== "string" || !/^[0-9a-f]{40}$/.test(source.sha)) {
    throw new Error(`mirror source.json has no valid source sha: ${JSON.stringify(source.sha)}`);
  }
  return source.sha;
}

async function mirrorCoversCommit(commitSha, mirroredSha) {
  if (commitSha === mirroredSha) {
    return true;
  }
  const comparison = await githubJson(
    `/repos/${SOURCE_REPO}/compare/${commitSha}...${mirroredSha}`,
  );
  // "ahead"/"identical": the mirrored sha contains the commit. "behind" or
  // "diverged" (mirror off main history) both count as not covered.
  return comparison.status === "identical" || comparison.status === "ahead";
}

async function countActiveSyncRuns() {
  let active = 0;
  for (const status of ["queued", "in_progress"]) {
    const runs = await githubJson(
      `/repos/${SOURCE_REPO}/actions/workflows/${SYNC_WORKFLOW}/runs?status=${status}&per_page=1`,
    );
    active += runs.total_count;
  }
  return active;
}

async function dispatchRecoverySync() {
  await githubJson(`/repos/${SOURCE_REPO}/actions/workflows/${SYNC_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
}

async function main() {
  const watchPaths = readSyncWatchPaths(fs.readFileSync(SYNC_WORKFLOW_FILE, "utf8")).map(
    toCommitApiPath,
  );
  const [newest, mirroredSha] = await Promise.all([
    newestWatchedCommit(watchPaths),
    readMirroredSourceSha(),
  ]);
  const ageMinutes = Math.round((Date.now() - newest.committedAt) / 60_000);
  const summary = `newest docs-touching main commit ${newest.sha} (${newest.path}, ${ageMinutes}m ago); mirror at ${mirroredSha}`;

  if (await mirrorCoversCommit(newest.sha, mirroredSha)) {
    console.log(`docs mirror fresh: ${summary}`);
    return;
  }
  if (ageMinutes < STALE_MINUTES) {
    console.log(
      `docs mirror trailing within ${STALE_MINUTES}m grace (sync in flight?): ${summary}`,
    );
    return;
  }

  const activeSyncRuns = await countActiveSyncRuns();
  if (activeSyncRuns === 0) {
    await dispatchRecoverySync();
    console.error(`dispatched ${SYNC_WORKFLOW} recovery run on main`);
  } else {
    console.error(
      `${activeSyncRuns} ${SYNC_WORKFLOW} run(s) already queued/in progress; not dispatching another`,
    );
  }
  fail(`docs mirror stale for ${ageMinutes}m (threshold ${STALE_MINUTES}m): ${summary}`);
}

try {
  await main();
} catch (error) {
  fail(`${TOOL} error: ${error instanceof Error ? error.message : String(error)}`);
}
