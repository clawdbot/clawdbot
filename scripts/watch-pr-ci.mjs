#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const USAGE =
  "Usage: node scripts/watch-pr-ci.mjs <pr-number> <head-sha> [--repo owner/repo] [--after run-id] [--attach-timeout 900] [--timeout 3600] [--interval 120]";
const FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STARTUP_FAILURE",
  "STALE",
  "TIMED_OUT",
]);
const ROLLUP_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{kind:__typename ... on CheckRun{name status conclusion databaseId checkSuite{workflowRun{databaseId workflow{databaseId}}}} ... on StatusContext{context state}}}}}}}`;
// Adapted from Node's MIT-licensed util.stripVTControlCharacters implementation.
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*" +
    "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?" +
    "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?" +
    "[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);
const UNSAFE_CHECK_NAME_RUN = /[^\u0020-\u007E\p{L}\p{M}\p{N}]+/gu;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string", default: "openclaw/openclaw" },
        after: { type: "string" },
        "attach-timeout": { type: "string", default: "900" },
        timeout: { type: "string", default: "3600" },
        interval: { type: "string", default: "120" },
      },
    });
  } catch {
    throw new Error(USAGE);
  }
  const [prValue, rawSha, ...extra] = parsed.positionals;
  if (!prValue || !rawSha || extra.length > 0) {
    throw new Error(USAGE);
  }
  const args = {
    pr: positiveInteger(prValue, "pr-number"),
    headSha: rawSha.toLowerCase(),
    repo: parsed.values.repo,
    attachTimeout: positiveInteger(parsed.values["attach-timeout"], "--attach-timeout"),
    timeout: positiveInteger(parsed.values.timeout, "--timeout"),
    interval: positiveInteger(parsed.values.interval, "--interval"),
  };
  if (parsed.values.after !== undefined) {
    args.after = positiveInteger(parsed.values.after, "--after");
  }
  if (!/^[0-9a-f]{40}$/u.test(args.headSha)) {
    throw new Error("head-sha must be a full 40-character commit SHA");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(args.repo)) {
    throw new Error("--repo must be owner/repo");
  }
  return args;
}

const checkName = (check) => (check.kind === "StatusContext" ? check.context : check.name);
export const sanitizeCheckName = (name) =>
  name.replaceAll(ANSI_ESCAPE_SEQUENCE, "\u0000").replaceAll(UNSAFE_CHECK_NAME_RUN, "?");
const isAutoResponse = (check) =>
  checkName(check)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim() === "auto response";

// Run identity for supersession; undefined when any id is missing so ambiguous
// nodes are never dropped (fails toward FAILING, never toward false GREEN).
// These databaseIds are GraphQL Int fields, but GitHub serializes Actions-scale
// 64-bit values in them (live-verified; no fullDatabaseId exists on these types).
// If GitHub ever nulls them, filtering degrades to pre-supersession behavior.
function checkRunIdentity(check) {
  if (check.kind !== "CheckRun") {
    return undefined;
  }
  const runId = check.checkSuite?.workflowRun?.databaseId;
  const workflowId = check.checkSuite?.workflowRun?.workflow?.databaseId;
  if (typeof runId !== "number" || typeof workflowId !== "number") {
    return undefined;
  }
  return { runId, workflowId };
}
// Strict recency ordering for same-name checks: newest run wins; within one run
// (rerun attempts reuse the run id) the newest check-run id wins.
const newerJob = (a, b) => (a.runId !== b.runId ? a.runId > b.runId : a.checkId > b.checkId);

export function classifyRollup(rollup) {
  const rawNodes = rollup?.contexts?.nodes ?? [];
  const hiddenContextCount = Math.max(
    0,
    (rollup?.contexts?.totalCount ?? rawNodes.length) - rawNodes.length,
  );
  const newestRunByWorkflow = new Map();
  const bestByJob = new Map();
  for (const check of rawNodes) {
    const identity = checkRunIdentity(check);
    if (!identity) {
      continue;
    }
    newestRunByWorkflow.set(
      identity.workflowId,
      Math.max(newestRunByWorkflow.get(identity.workflowId) ?? 0, identity.runId),
    );
    if (check.name && typeof check.databaseId === "number") {
      const key = `${identity.workflowId}:${check.name}`;
      const candidate = { runId: identity.runId, checkId: check.databaseId };
      const best = bestByJob.get(key);
      if (!best || newerJob(candidate, best)) {
        bestByJob.set(key, candidate);
      }
    }
  }
  let supersededCount = 0;
  // Re-triggers leave every prior run's check runs on the SHA forever and GitHub's aggregate
  // counts them. A check is superseded when a newer same-workflow check shares its name
  // (GitHub's latest-name-wins semantics), or when it was cancelled and its workflow has a
  // newer run (draft->ready cancels the old run before the replacement posts check runs).
  // Older-run checks with unique names stay visible so distinct invocations are not dropped.
  const nodes = rawNodes.filter((check) => {
    const identity = checkRunIdentity(check);
    if (!identity) {
      return true;
    }
    if (check.name && typeof check.databaseId === "number") {
      const best = bestByJob.get(`${identity.workflowId}:${check.name}`);
      if (best && newerJob(best, { runId: identity.runId, checkId: check.databaseId })) {
        supersededCount += 1;
        return false;
      }
    }
    const newestRun = newestRunByWorkflow.get(identity.workflowId);
    if (check.conclusion === "CANCELLED" && newestRun > identity.runId) {
      supersededCount += 1;
      return false;
    }
    return true;
  });
  const checks = nodes.filter((check) => !isAutoResponse(check));
  const pendingCount = checks.filter((check) =>
    check.kind === "StatusContext"
      ? check.state === "PENDING" || check.state === "EXPECTED"
      : check.status !== "COMPLETED",
  ).length;
  const failingChecks = checks.filter((check) => {
    if (check.kind === "StatusContext") {
      return check.state === "ERROR" || check.state === "FAILURE";
    }
    return FAILURE_CONCLUSIONS.has(check.conclusion);
  });
  const failingNames = failingChecks
    .map(checkName)
    .filter(Boolean)
    .map(sanitizeCheckName)
    .toSorted()
    .filter((name, index, names) => name !== names[index - 1]);
  if (rollup?.state === "SUCCESS") {
    return { verdict: "GREEN", pendingCount, failingNames: [], supersededCount };
  }
  if (rollup?.state === "ERROR" || rollup?.state === "FAILURE") {
    if (failingChecks.length > 0) {
      return {
        verdict: "FAILING",
        pendingCount,
        failingNames: [
          ...(failingNames.length > 0 ? failingNames : ["status rollup"]),
          ...(hiddenContextCount > 0 ? [`+${hiddenContextCount} more contexts not shown`] : []),
        ],
        supersededCount,
      };
    }
    if (hiddenContextCount > 0) {
      return {
        verdict: "FAILING",
        pendingCount,
        failingNames: ["status rollup", `+${hiddenContextCount} more contexts not shown`],
        supersededCount,
      };
    }
    if (pendingCount > 0) {
      return { verdict: "PENDING", pendingCount, failingNames: [], supersededCount };
    }
    // GitHub's aggregate permanently counts superseded cancellations. With full visibility,
    // an all-green newest-run set is green; main() also requires the attached run to succeed.
    return { verdict: "GREEN", pendingCount, failingNames: [], supersededCount };
  }
  return { verdict: "PENDING", pendingCount, failingNames: [], supersededCount };
}

function ghJson(...args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }),
  );
}

const readPr = (pr, repo) =>
  ghJson(...`pr view ${pr} --repo ${repo} --json state,mergeable,headRefOid`.split(" "));
export const buildFindRunArgs = (repo, sha) => [
  "run",
  "list",
  "--repo",
  repo,
  "--commit",
  sha,
  "--workflow",
  "ci.yml",
  "--event",
  "pull_request",
  "--limit",
  "1",
  "--json",
  "createdAt,databaseId",
];
export const selectRunAfter = (runs, after) =>
  runs.find((run) => after === undefined || run.databaseId > after);
const findRun = (repo, sha, after) => selectRunAfter(ghJson(...buildFindRunArgs(repo, sha)), after);
const readRun = (repo, runId) =>
  ghJson(...`run view ${runId} --repo ${repo} --json status,conclusion`.split(" "));

export function classifyRunAttachment(runId, run, after) {
  if (run.conclusion === "skipped") {
    return { attach: false };
  }
  return {
    attach: true,
    warning:
      after === undefined && String(run.status).toLowerCase() === "completed"
        ? `WARN attaching to already-completed run ${runId} (started before watcher); pass --after ${runId} to require a fresh run`
        : undefined,
  };
}

export function collectRollupContexts(fetchPage) {
  const firstPage = fetchPage(null);
  const firstContexts = firstPage?.statusCheckRollup?.contexts;
  if (!firstContexts) {
    return firstPage;
  }

  const nodes = [...(firstContexts.nodes ?? [])];
  let pageInfo = firstContexts.pageInfo;
  let pageCount = 1;
  // Polling work stays bounded at 1,000 contexts. Any truncation remains visible through
  // totalCount and must classify conservatively rather than reading as success.
  while (pageInfo?.hasNextPage && pageCount < 10) {
    if (typeof pageInfo.endCursor !== "string") {
      throw new Error("rollup page advertised a next page without a cursor");
    }
    const page = fetchPage(pageInfo.endCursor);
    const contexts = page?.statusCheckRollup?.contexts;
    pageCount += 1;
    // Losing an advertised page (head moved, transient API gap) or reading a changed snapshot
    // must not pass off the partial first page as complete; the watch loop catches this error
    // and re-reads the rollup on its next bounded poll.
    if (!contexts) {
      throw new Error("rollup snapshot changed during pagination");
    }
    if (
      page.headRefOid !== firstPage.headRefOid ||
      page.statusCheckRollup?.state !== firstPage.statusCheckRollup?.state ||
      contexts.totalCount !== firstContexts.totalCount
    ) {
      throw new Error("rollup snapshot changed during pagination");
    }
    nodes.push(...(contexts.nodes ?? []));
    pageInfo = contexts.pageInfo;
  }

  return {
    ...firstPage,
    statusCheckRollup: {
      ...firstPage.statusCheckRollup,
      contexts: { ...firstContexts, nodes },
    },
  };
}

function readRollup(pr, repo) {
  const [owner, name] = repo.split("/");
  return collectRollupContexts((cursor) => {
    const queryArgs = [
      "api",
      "graphql",
      "-f",
      `query=${ROLLUP_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ];
    if (cursor !== null) {
      queryArgs.push("-f", `cursor=${cursor}`);
    }
    return ghJson(...queryArgs).data?.repository?.pullRequest;
  });
}

const emit = (line, code) => {
  console.log(line);
  return code;
};
export async function pollUntilDeadline({
  deadline,
  interval,
  poll,
  now = Date.now,
  wait = sleep,
}) {
  while (true) {
    const result = await poll();
    if (result !== undefined) {
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return undefined;
    }
    await wait(Math.min(interval * 1000, remaining));
  }
}
const retry = (phase, error) =>
  console.log(
    `RETRY phase=${phase} error=${(error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ")}`,
  );

function precheck(pr, sha, midWait = false) {
  const state = String(pr?.state ?? "MISSING").toUpperCase();
  if (state !== "OPEN") {
    return emit(`PR-CLOSED state=${state}`, 10);
  }
  if (pr.headRefOid !== sha) {
    return emit(`HEAD-MOVED expected=${sha} actual=${pr.headRefOid}`, 11);
  }
  if (pr.mergeable === false || String(pr.mergeable).toUpperCase() === "CONFLICTING") {
    return emit(
      `${midWait ? "CONFLICTING-MID-WAIT" : "CONFLICTING"} mergeable=CONFLICTING`,
      midWait ? 14 : 12,
    );
  }
  return null;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const attachDeadline = Date.now() + args.attachTimeout * 1000;
  const attachment = await pollUntilDeadline({
    deadline: attachDeadline,
    interval: args.interval,
    poll: () => {
      try {
        const blocked = precheck(readPr(args.pr, args.repo), args.headSha);
        if (blocked !== null) {
          return { exitCode: blocked };
        }
        const candidate = findRun(args.repo, args.headSha, args.after);
        if (candidate) {
          const classification = classifyRunAttachment(
            candidate.databaseId,
            readRun(args.repo, candidate.databaseId),
            args.after,
          );
          if (classification.attach) {
            if (classification.warning) {
              console.log(classification.warning);
            }
            return { runId: candidate.databaseId };
          }
        }
      } catch (error) {
        retry("attach", error);
      }
      return undefined;
    },
  });
  if (attachment === undefined) {
    return emit(
      'NO-RUN-ATTACHED hint="close/reopen re-fires CI; pr-ci-sweeper re-fires hourly at :07"',
      13,
    );
  }
  if ("exitCode" in attachment) {
    return attachment.exitCode;
  }
  const { runId } = attachment;
  console.log(`ATTACHED run=${runId} url=https://github.com/${args.repo}/actions/runs/${runId}`);

  const watchDeadline = Date.now() + args.timeout * 1000;
  let lastState = "NONE";
  let lastPending = 0;
  const watchResult = await pollUntilDeadline({
    deadline: watchDeadline,
    interval: args.interval,
    poll: () => {
      try {
        const pr = readRollup(args.pr, args.repo);
        const blocked = precheck(pr, args.headSha, true);
        if (blocked !== null) {
          return blocked;
        }
        const result = classifyRollup(pr.statusCheckRollup);
        lastState = pr.statusCheckRollup?.state ?? "NONE";
        lastPending = result.pendingCount;
        console.log(
          `STATUS state=${lastState} pending=${lastPending} superseded=${result.supersededCount}`,
        );
        if (result.verdict === "FAILING") {
          return emit(`FAILING checks=${result.failingNames.join(", ")}`, 15);
        }
        const run = readRun(args.repo, runId);
        if (run.status === "completed" && run.conclusion !== "success") {
          return emit(`FAILING checks=CI workflow (${run.conclusion ?? "unknown"})`, 15);
        }
        if (
          result.verdict === "GREEN" &&
          run.status === "completed" &&
          run.conclusion === "success"
        ) {
          return emit("GREEN", 0);
        }
      } catch (error) {
        retry("watch", error);
      }
      return undefined;
    },
  });
  if (watchResult !== undefined) {
    return watchResult;
  }
  return emit(`TIMEOUT state=${lastState} pending=${lastPending}`, 16);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
