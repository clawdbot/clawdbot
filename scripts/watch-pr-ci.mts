#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import { z } from "zod";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { execGhJson, workflowRunsApiArgs } from "./lib/plain-gh.mjs";

const USAGE =
  "Usage: node scripts/watch-pr-ci.mjs <pr-number> <head-sha> [--repo owner/repo] [--after run-id] [--attach-timeout 900] [--timeout 3600] [--interval 120] [--completion rollup|ci-run]";

const optional = <T,>(schema: z.ZodType<T>) => schema.optional().catch(undefined);
const optionalNullable = <T,>(schema: z.ZodType<T>) => optional(schema.nullable());
const validArray = <T,>(schema: z.ZodType<T>) =>
  z.array(z.unknown()).transform((values) =>
    values.flatMap((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const optionalString = optional(z.string());
const optionalNumber = optional(z.number());
const RollupCheckSchema = z.object({
  kind: z.enum(["CheckRun", "StatusContext"]),
  databaseId: optionalNumber,
  name: optionalString,
  context: optionalString,
  status: optionalString,
  conclusion: optionalNullable(z.string()),
  state: optionalString,
  checkSuite: optionalNullable(
    z.object({
      databaseId: optionalNumber,
      workflowRun: optionalNullable(
        z.object({
          databaseId: optionalNumber,
          event: optionalString,
          workflow: optional(z.object({ databaseId: optionalNumber })),
        }),
      ),
    }),
  ),
});
const RollupPayloadSchema = z.object({
  state: optionalString,
  contexts: optional(
    z.object({
      totalCount: optionalNumber,
      nodes: optional(validArray(RollupCheckSchema)),
      pageInfo: optional(
        z.object({
          hasNextPage: optional(z.boolean()),
          endCursor: optionalNullable(z.string()),
        }),
      ),
    }),
  ),
});
const RollupPageSchema = z
  .object({
    state: optionalString,
    mergeable: optional(z.union([z.boolean(), z.string()])),
    headRefOid: optionalString,
    statusCheckRollup: optionalNullable(RollupPayloadSchema),
  })
  .catch({});
const RollupResponseSchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: RollupPageSchema.nullish() }).nullish(),
  }),
});
const RunListItemSchema = z.object({
  id: z.number(),
  workflow_id: optionalNumber,
  check_suite_id: optionalNumber,
  event: optionalString,
  head_sha: optionalString,
  // Do not discard malformed members: that could make an ambiguous association unique.
  pull_requests: optional(
    z.array(z.object({ number: z.number().int().positive(), head: z.object({ sha: z.string() }) })),
  ),
  conclusion: optionalNullable(z.string()),
});
const RunListSchema = z
  .object({ workflow_runs: validArray(RunListItemSchema) })
  .transform((response) => response.workflow_runs)
  .catch([]);
const RunStatusSchema = z
  .object({ status: optionalString, conclusion: optionalNullable(z.string()) })
  .catch({});
const evidenceId = z.number().int().positive();
const CompletedRunSchema = z.object({
  id: evidenceId,
  workflow_id: evidenceId,
  head_sha: z.string(),
  run_attempt: evidenceId,
  path: z.literal(".github/workflows/ci.yml"),
  status: z.literal("completed"),
  conclusion: z.literal("success"),
});
const AttemptJobSchema = z.object({
  id: evidenceId,
  run_id: evidenceId,
  run_attempt: evidenceId,
  head_sha: z.string(),
  name: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullable(),
  runner_id: evidenceId.nullable(),
  steps: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
const AttemptJobsPageSchema = z.object({
  total_count: z.number().int().nonnegative().max(1_000),
  jobs: z.array(AttemptJobSchema).max(100),
});

type RollupCheck = z.infer<typeof RollupCheckSchema>;
type RollupPayload = z.infer<typeof RollupPayloadSchema>;
type RollupPage = z.infer<typeof RollupPageSchema>;
type RunListItem = z.infer<typeof RunListItemSchema>;
type RunStatus = z.infer<typeof RunStatusSchema>;
type JobIdentity = { runId: number; checkId: number };
type PrRunReplacement = { workflowId: number; checkSuites: ReadonlyMap<number, number> };
const FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STARTUP_FAILURE",
  "STALE",
  "TIMED_OUT",
]);
const ROLLUP_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{kind:__typename ... on CheckRun{name status conclusion databaseId checkSuite{databaseId workflowRun{databaseId event workflow{databaseId}}}} ... on StatusContext{context state}}}}}}}`;
const MAX_EVIDENCE_READS_PER_POLL = 32;
const GH_READ_OPTIONS = {
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 60_000,
} satisfies Parameters<typeof execGhJson>[1];
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

function positiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv: string[]) {
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
        completion: { type: "string", default: "rollup" },
      },
    });
  } catch {
    throw new Error(USAGE);
  }
  const [prValue, rawSha, ...extra] = parsed.positionals;
  if (!prValue || !rawSha || extra.length > 0) {
    throw new Error(USAGE);
  }
  const completion = parsed.values.completion;
  if (completion !== "rollup" && completion !== "ci-run") {
    throw new Error("--completion must be rollup or ci-run");
  }
  const args = {
    pr: positiveInteger(prValue, "pr-number"),
    headSha: rawSha.toLowerCase(),
    repo: parsed.values.repo,
    ...(parsed.values.after === undefined
      ? {}
      : { after: positiveInteger(parsed.values.after, "--after") }),
    attachTimeout: positiveInteger(parsed.values["attach-timeout"], "--attach-timeout"),
    timeout: positiveInteger(parsed.values.timeout, "--timeout"),
    interval: positiveInteger(parsed.values.interval, "--interval"),
    completion,
  };
  if (!/^[0-9a-f]{40}$/u.test(args.headSha)) {
    throw new Error("head-sha must be a full 40-character commit SHA");
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(args.repo)) {
    throw new Error("--repo must be owner/repo");
  }
  return args;
}

const checkName = (check: RollupCheck) =>
  check.kind === "StatusContext" ? check.context : check.name;
export const sanitizeCheckName = (name: string) =>
  name.replaceAll(ANSI_ESCAPE_SEQUENCE, "\u0000").replaceAll(UNSAFE_CHECK_NAME_RUN, "?");
const isAutoResponse = (check: RollupCheck) =>
  checkName(check)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim() === "auto response";

// Run identity for supersession; undefined when any id is missing so ambiguous
// nodes are never dropped (fails toward FAILING, never toward false GREEN).
// These databaseIds are GraphQL Int fields, but GitHub serializes Actions-scale
// 64-bit values in them (live-verified; no fullDatabaseId exists on these types).
// If GitHub ever nulls them, filtering degrades to pre-supersession behavior.
function checkRunIdentity(check: RollupCheck) {
  if (check.kind !== "CheckRun") {
    return undefined;
  }
  const runId = check.checkSuite?.workflowRun?.databaseId;
  const workflowId = check.checkSuite?.workflowRun?.workflow?.databaseId;
  if (typeof runId !== "number" || typeof workflowId !== "number") {
    return undefined;
  }
  return { runId, workflowId, event: check.checkSuite?.workflowRun?.event };
}
// Strict recency ordering for same-name checks: newest run wins; within one run
// (rerun attempts reuse the run id) the newest check-run id wins.
const newerJob = (a: JobIdentity, b: JobIdentity) =>
  a.runId !== b.runId ? a.runId > b.runId : a.checkId > b.checkId;

export function classifyRollup(
  rollup: RollupPayload | null | undefined,
  reconciledChecks: ReadonlyMap<number, string> = new Map(),
  replacement?: PrRunReplacement,
  pendingEvidence: ReadonlySet<RollupCheck> = new Set(),
) {
  const rawNodes = rollup?.contexts?.nodes ?? [];
  const hiddenContextCount = Math.max(
    0,
    (rollup?.contexts?.totalCount ?? rawNodes.length) - rawNodes.length,
  );
  const isReconciledPlaceholder = (check: RollupCheck) =>
    check.databaseId !== undefined &&
    check.name !== undefined &&
    check.name.length > 0 &&
    check.status === "QUEUED" &&
    check.conclusion === null &&
    reconciledChecks.get(check.databaseId) === check.name;
  const bestByJob = new Map<string, JobIdentity & { reconciled: boolean }>();
  for (const check of rawNodes) {
    const identity = checkRunIdentity(check);
    if (!identity) {
      continue;
    }
    if (check.name && typeof check.databaseId === "number") {
      const key = `${identity.workflowId}:${identity.event ?? ""}:${check.name}`;
      const reconciled = isReconciledPlaceholder(check);
      const candidate = { runId: identity.runId, checkId: check.databaseId, reconciled };
      const best = bestByJob.get(key);
      if (!best || newerJob(candidate, best)) {
        bestByJob.set(key, candidate);
      }
    }
  }
  let supersededCount = 0;
  let reconciledCount = 0;
  // GitHub CLI deduplicates same-name checks within a workflow/event on the shared SHA.
  // Unique jobs, including cancellations, need exact same-PR run/suite replacement proof.
  const nodes = rawNodes.filter((check) => {
    const identity = checkRunIdentity(check);
    if (!identity) {
      return true;
    }
    // A shared head can belong to different PR bases. Only event-bound run/suite
    // evidence permits replacing an older graph before new job names appear.
    const replacedSuite = replacement?.checkSuites.get(identity.runId);
    if (
      replacedSuite !== undefined &&
      identity.workflowId === replacement?.workflowId &&
      check.checkSuite?.databaseId === replacedSuite &&
      check.checkSuite?.workflowRun?.event === "pull_request"
    ) {
      supersededCount += 1;
      return false;
    }
    // Proof covers the queued observation, not a later name or outcome of the same ID.
    if (isReconciledPlaceholder(check)) {
      reconciledCount += 1;
      supersededCount += 1;
      return false;
    }
    if (check.name && typeof check.databaseId === "number") {
      const best = bestByJob.get(`${identity.workflowId}:${identity.event ?? ""}:${check.name}`);
      // A removed placeholder cannot hide a verified sibling that changed in this
      // attempt. Uncovered earlier attempts and newer runs retain normal supersession.
      const changedAlias = reconciledChecks.has(check.databaseId);
      if (
        best &&
        !(best.reconciled && best.runId === identity.runId && changedAlias) &&
        newerJob(best, { runId: identity.runId, checkId: check.databaseId })
      ) {
        supersededCount += 1;
        return false;
      }
    }
    return true;
  });
  const checks = nodes.filter((check) => !isAutoResponse(check));
  const pendingCount = checks.filter(
    (check) =>
      pendingEvidence.has(check) ||
      (check.kind === "StatusContext"
        ? check.state === "PENDING" || check.state === "EXPECTED"
        : check.status !== "COMPLETED"),
  ).length;
  const failingChecks = checks.filter((check) => {
    if (pendingEvidence.has(check)) {
      return false;
    }
    if (check.kind === "StatusContext") {
      return check.state === "ERROR" || check.state === "FAILURE";
    }
    return typeof check.conclusion === "string" && FAILURE_CONCLUSIONS.has(check.conclusion);
  });
  const failingNames = failingChecks
    .map(checkName)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map(sanitizeCheckName)
    .toSorted()
    .filter((name, index, names) => name !== names[index - 1]);
  if (rollup?.state === "SUCCESS") {
    return { verdict: "GREEN", pendingCount, failingNames: [], supersededCount };
  }
  if (
    rollup?.state === "ERROR" ||
    rollup?.state === "FAILURE" ||
    (rollup?.state === "PENDING" && reconciledCount > 0)
  ) {
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
    // A refresh can invalidate every alias proof. Unknown outcomes still block,
    // even when no placeholder was removed from this snapshot.
    const hasUnresolvedChecks = checks.some(
      (check) =>
        pendingEvidence.has(check) ||
        (check.kind === "StatusContext"
          ? check.state !== "SUCCESS"
          : check.status !== "COMPLETED" ||
            !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? "")),
    );
    if (hasUnresolvedChecks) {
      return { verdict: "PENDING", pendingCount, failingNames: [], supersededCount };
    }
    // GitHub's aggregate permanently counts superseded cancellations. With full visibility,
    // an all-green newest-run set is green; main() also requires the attached run to succeed.
    return { verdict: "GREEN", pendingCount, failingNames: [], supersededCount };
  }
  return { verdict: "PENDING", pendingCount, failingNames: [], supersededCount };
}

function ghReadOptions(deadline?: number) {
  if (deadline === undefined) {
    return GH_READ_OPTIONS;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("watcher evidence deadline elapsed");
  }
  return { ...GH_READ_OPTIONS, timeout: Math.min(GH_READ_OPTIONS.timeout, remaining) };
}

const readPr = (pr: number, repo: string, deadline?: number) =>
  RollupPageSchema.parse(
    execGhJson(
      `pr view ${pr} --repo ${repo} --json state,mergeable,headRefOid`.split(" "),
      ghReadOptions(deadline),
    ),
  );
export const buildFindRunArgs = (repo: string, sha: string) =>
  workflowRunsApiArgs(repo, sha, "pull_request", 20);
export const selectRunAfter = (runs: RunListItem[], after?: number) =>
  runs.find((run) => run.conclusion !== "skipped" && (after === undefined || run.id > after));
function findRun(repo: string, sha: string, after?: number, pr?: number) {
  const runs = RunListSchema.parse(execGhJson(buildFindRunArgs(repo, sha), GH_READ_OPTIONS));
  const candidates =
    pr === undefined
      ? runs
      : runs.filter(
          (run) =>
            !run.pull_requests?.length ||
            run.pull_requests.some((request) => request.number === pr),
        );
  const run = selectRunAfter(candidates, after);
  if (!run) {
    return undefined;
  }
  return { run, runs: new Map(runs.map((item) => [item.id, item])) };
}
const readRun = (repo: string, runId: number, deadline?: number) =>
  RunStatusSchema.parse(
    execGhJson(
      `run view ${runId} --repo ${repo} --json status,conclusion`.split(" "),
      ghReadOptions(deadline),
    ),
  );

function readQueuedPlaceholderEvidence(
  repo: string,
  headSha: string,
  attached: RunListItem,
  rollup: RollupPayload,
  deadline: number,
) {
  const reconciled = new Map<number, string>();
  const contexts = rollup.contexts;
  const nodes = contexts?.nodes ?? [];
  if (
    !["FAILURE", "ERROR", "PENDING"].includes(rollup.state ?? "") ||
    contexts?.totalCount !== nodes.length ||
    contexts.pageInfo?.hasNextPage !== false
  ) {
    return reconciled;
  }
  const queued = nodes.flatMap((check) => {
    const identity = checkRunIdentity(check);
    return check.status === "QUEUED" &&
      check.conclusion === null &&
      check.name &&
      check.databaseId !== undefined &&
      identity?.runId === attached.id &&
      identity.workflowId === attached.workflow_id
      ? [{ name: check.name, id: check.databaseId }]
      : [];
  });
  if (queued.length === 0) {
    return reconciled;
  }
  const runPath = `repos/${repo}/actions/runs/${attached.id}`;
  // Request current evidence through the shared gh seam; the final run read must
  // not deliberately reuse the snapshot from before job collection.
  const readEvidence = (endpoint: string) =>
    execGhJson(["api", endpoint, "-H", "Cache-Control: max-age=0"], ghReadOptions(deadline));
  const readCompletedRun = () => CompletedRunSchema.parse(readEvidence(runPath));
  const run = readCompletedRun();
  if (
    run.id !== attached.id ||
    run.head_sha !== headSha ||
    run.workflow_id !== attached.workflow_id
  ) {
    return reconciled;
  }
  const jobs: z.infer<typeof AttemptJobSchema>[] = [];
  let totalCount: number | undefined;
  // Attempt-specific pagination is bounded like the rollup; incomplete or duplicate
  // pages cannot establish that no active/failed same-name sibling exists.
  for (let page = 1; page <= 10; page += 1) {
    const response = AttemptJobsPageSchema.parse(
      readEvidence(`${runPath}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`),
    );
    totalCount ??= response.total_count;
    if (response.total_count !== totalCount || response.jobs.length === 0) {
      return reconciled;
    }
    jobs.push(...response.jobs);
    if (jobs.length >= totalCount) {
      break;
    }
  }
  if (jobs.length !== totalCount || new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    return reconciled;
  }
  const sameAttempt = (job: z.infer<typeof AttemptJobSchema>) =>
    job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === headSha;
  const unassignedQueued = (job: z.infer<typeof AttemptJobSchema>) =>
    job.status === "queued" && job.conclusion === null && job.runner_id === null;
  let remainingAliasReads = MAX_EVIDENCE_READS_PER_POLL;
  for (const name of new Set(queued.map((check) => check.name))) {
    const checks = queued.filter((check) => check.name === name);
    const siblings = jobs.filter((job) => job.name === name);
    const aliases = siblings.filter(unassignedQueued);
    const executed = siblings.filter((job) => !unassignedQueued(job));
    const replacement = executed[0];
    if (
      executed.length !== 1 ||
      !replacement ||
      !siblings.every(sameAttempt) ||
      !checks.every((check) => aliases.some((job) => job.id === check.id)) ||
      replacement.status !== "completed" ||
      replacement.conclusion !== "success" ||
      replacement.runner_id === null ||
      replacement.steps.length === 0 ||
      replacement.steps.some(
        (step) =>
          step.status !== "completed" ||
          !["success", "skipped", "neutral"].includes(step.conclusion ?? ""),
      )
    ) {
      continue;
    }
    // One request per alias can outlive a poll or exhaust API quota. Oversized
    // groups stay pending; partial verification never proves supersession.
    if (aliases.length > remainingAliasReads) {
      console.log("WARN queued-alias evidence exceeds the per-poll request budget");
      continue;
    }
    // The list can copy executed steps onto queued aliases, including ones absent
    // from GraphQL. Prove the entire group unexecuted before dropping any visible ID.
    const unexecuted = aliases.every((alias) => {
      remainingAliasReads -= 1;
      const direct = AttemptJobSchema.parse(readEvidence(`repos/${repo}/actions/jobs/${alias.id}`));
      return (
        direct.id === alias.id &&
        direct.name === name &&
        sameAttempt(direct) &&
        unassignedQueued(direct) &&
        direct.steps.length === 0
      );
    });
    if (unexecuted) {
      // The refreshed rollup can reveal an alias omitted from the first snapshot.
      for (const alias of aliases) {
        reconciled.set(alias.id, name);
      }
    }
  }
  // Reruns reuse a run ID. Evidence from the completed attempt cannot authorize
  // completion after a newer attempt starts while the job pages are being read.
  const current = readCompletedRun();
  if (JSON.stringify(current) !== JSON.stringify(run)) {
    return new Map<number, string>();
  }
  return reconciled;
}

export function classifyRunAttachment(runId: number, run: RunStatus, after?: number) {
  if (run.conclusion === "skipped") {
    return { attach: false };
  }
  return {
    attach: true,
    warning:
      after === undefined && run.status?.toLowerCase() === "completed"
        ? `WARN attaching to already-completed run ${runId} (started before watcher); pass --after ${runId} to require a fresh run`
        : undefined,
  };
}

export function classifyAttachedCiRun(run: RunStatus) {
  if (run.status !== "completed") {
    return { verdict: "PENDING" };
  }
  return run.conclusion === "success"
    ? { verdict: "GREEN" }
    : { verdict: "FAILING", conclusion: run.conclusion ?? "unknown" };
}

export function collectRollupContexts(
  fetchPage: (cursor: string | null) => RollupPage | null | undefined,
) {
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
      contexts: { ...firstContexts, nodes, pageInfo },
    },
  };
}

function readRollup(pr: number, repo: string, deadline?: number) {
  const [owner, name] = repo.split("/");
  return (
    collectRollupContexts((cursor) => {
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
      const response = RollupResponseSchema.safeParse(
        execGhJson(queryArgs, ghReadOptions(deadline)),
      );
      return response.success ? response.data.data.repository?.pullRequest : undefined;
    }) ?? {}
  );
}

function readPrRollup(
  args: ReturnType<typeof parseArgs>,
  attachment: NonNullable<ReturnType<typeof findRun>>,
  deadline: number,
  reads: { remaining: number },
  reconciled?: ReadonlyMap<number, string>,
) {
  const { run, runs } = attachment;
  const boundToPr = (candidate: RunListItem) =>
    candidate.event === "pull_request" &&
    candidate.head_sha === args.headSha &&
    candidate.pull_requests?.length === 1 &&
    candidate.pull_requests[0]?.number === args.pr &&
    candidate.pull_requests[0]?.head.sha === args.headSha;
  const checkSuites = new Map<number, number>();
  const pendingEvidence = new Set<RollupCheck>();
  const replacement =
    boundToPr(run) && run.workflow_id !== undefined && run.check_suite_id !== undefined
      ? { workflowId: run.workflow_id, checkSuites }
      : undefined;
  while (true) {
    const pr = readRollup(args.pr, args.repo, deadline);
    const blocked = precheck(pr, args.headSha, true);
    if (blocked !== null) {
      return { exitCode: blocked };
    }
    if (pr.statusCheckRollup?.state === "SUCCESS") {
      return { pr, result: classifyRollup(pr.statusCheckRollup, reconciled) };
    }
    const knownRuns = runs.size;
    // Pending evidence belongs only to these exact observations, never a later
    // check state or a different workflow/event sharing its run ID.
    pendingEvidence.clear();
    for (const check of pr.statusCheckRollup?.contexts?.nodes ?? []) {
      const identity = checkRunIdentity(check);
      if (
        !replacement ||
        !identity ||
        identity.runId >= run.id ||
        identity.workflowId !== replacement.workflowId ||
        identity.event !== "pull_request" ||
        check.checkSuite?.databaseId === undefined
      ) {
        continue;
      }
      // The attachment page is not history. Resolve only rollup-referenced IDs,
      // caching even unbound results so repeated jobs/polls do not multiply reads.
      let previous = runs.get(identity.runId);
      if (!previous) {
        if (reads.remaining === 0) {
          pendingEvidence.add(check);
          continue;
        }
        reads.remaining -= 1;
        previous = RunListItemSchema.parse(
          execGhJson(
            ["api", `repos/${args.repo}/actions/runs/${identity.runId}`],
            ghReadOptions(deadline),
          ),
        );
        runs.set(identity.runId, previous);
      }
      if (
        previous.id === identity.runId &&
        previous.workflow_id === replacement.workflowId &&
        previous.check_suite_id !== undefined &&
        boundToPr(previous)
      ) {
        checkSuites.set(previous.id, previous.check_suite_id);
      }
    }
    // Metadata reads can span a push or new checks. Reobserve before deciding;
    // any newly referenced IDs are resolved within the same watcher deadline.
    if (runs.size === knownRuns) {
      if (pendingEvidence.size > 0) {
        console.log(`STATUS evidence=PENDING deferred-checks=${pendingEvidence.size}`);
      }
      return {
        pr,
        result: classifyRollup(pr.statusCheckRollup, reconciled, replacement, pendingEvidence),
      };
    }
  }
}

const emit = (line: string, code: number) => {
  console.log(line);
  return code;
};
export async function pollUntilDeadline<T>({
  deadline,
  interval,
  poll,
  now = Date.now,
  wait = sleep,
}: {
  deadline: number;
  interval: number;
  poll: () => T | undefined | Promise<T | undefined>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T | undefined> {
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
const retry = (phase: string, error: unknown) =>
  console.log(
    `RETRY phase=${phase} error=${(error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ")}`,
  );

function precheck(pr: RollupPage, sha: string, midWait = false) {
  const state = (pr.state ?? "MISSING").toUpperCase();
  if (state !== "OPEN") {
    return emit(`PR-CLOSED state=${state}`, 10);
  }
  if (pr.headRefOid !== sha) {
    return emit(`HEAD-MOVED expected=${sha} actual=${pr.headRefOid}`, 11);
  }
  if (
    pr.mergeable === false ||
    (typeof pr.mergeable === "string" && pr.mergeable.toUpperCase() === "CONFLICTING")
  ) {
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
        const candidate = findRun(
          args.repo,
          args.headSha,
          args.after,
          args.completion === "rollup" ? args.pr : undefined,
        );
        if (candidate) {
          const classification = classifyRunAttachment(
            candidate.run.id,
            readRun(args.repo, candidate.run.id),
            args.after,
          );
          if (classification.attach) {
            if (classification.warning) {
              console.log(classification.warning);
            }
            return candidate;
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
  const attached = attachment.run;
  const runId = attached.id;
  console.log(`ATTACHED run=${runId} url=https://github.com/${args.repo}/actions/runs/${runId}`);

  const watchDeadline = Date.now() + args.timeout * 1000;
  let lastState = "NONE";
  let lastPending = 0;
  const watchResult = await pollUntilDeadline({
    deadline: watchDeadline,
    interval: args.interval,
    poll: () => {
      try {
        if (args.completion === "ci-run") {
          const blocked = precheck(readPr(args.pr, args.repo, watchDeadline), args.headSha, true);
          if (blocked !== null) {
            return blocked;
          }
          const run = readRun(args.repo, runId, watchDeadline);
          const result = classifyAttachedCiRun(run);
          const runStatus = run.status ?? "undefined";
          const runConclusion = run.conclusion ?? "pending";
          console.log(`STATUS run=${runStatus} conclusion=${runConclusion}`);
          if (result.verdict === "FAILING") {
            return emit(`FAILING checks=CI workflow (${result.conclusion})`, 15);
          }
          if (result.verdict === "GREEN") {
            return emit("GREEN", 0);
          }
          return undefined;
        }
        const reads = { remaining: MAX_EVIDENCE_READS_PER_POLL };
        let observed = readPrRollup(args, attachment, watchDeadline, reads);
        if ("exitCode" in observed) {
          return observed.exitCode;
        }
        let { pr, result } = observed;
        lastState = pr.statusCheckRollup?.state ?? "NONE";
        lastPending = result.pendingCount;
        let run =
          result.verdict === "FAILING" ? undefined : readRun(args.repo, runId, watchDeadline);
        if (
          result.verdict === "PENDING" &&
          result.pendingCount > 0 &&
          run?.status === "completed" &&
          run.conclusion === "success" &&
          pr.statusCheckRollup
        ) {
          const reconciled = readQueuedPlaceholderEvidence(
            args.repo,
            args.headSha,
            attached,
            pr.statusCheckRollup,
            watchDeadline,
          );
          if (reconciled.size > 0) {
            // The evidence scan may span pushes or new checks. Reobserve the PR
            // before applying proof, then retain the ordinary final CI-run check.
            observed = readPrRollup(args, attachment, watchDeadline, reads, reconciled);
            if ("exitCode" in observed) {
              return observed.exitCode;
            }
            ({ pr, result } = observed);
            run =
              result.verdict === "FAILING" ? undefined : readRun(args.repo, runId, watchDeadline);
          }
        }
        lastState = pr.statusCheckRollup?.state ?? "NONE";
        lastPending = result.pendingCount;
        console.log(
          `STATUS state=${lastState} pending=${lastPending} superseded=${result.supersededCount}`,
        );
        if (result.verdict === "FAILING") {
          return emit(`FAILING checks=${result.failingNames.join(", ")}`, 15);
        }
        if (run?.status === "completed" && run.conclusion !== "success") {
          return emit(`FAILING checks=CI workflow (${run.conclusion ?? "unknown"})`, 15);
        }
        if (
          result.verdict === "GREEN" &&
          run?.status === "completed" &&
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
