import type {
  CronJob,
  CronJobsListResult,
  CronRunLogEntry,
  CronRunsResult,
  CronStatus,
} from "../ui/src/api/types.ts";

const CRON_LIST_SNAPSHOT_REVISION = "control-ui-mock-cron";

function listResult(
  jobs: CronJob[],
  options: { total?: number; limit?: number; offset?: number } = {},
): CronJobsListResult {
  const total = options.total ?? jobs.length;
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const nextOffset = offset + jobs.length;
  const hasMore = nextOffset < total;
  return {
    jobs,
    snapshotRevision: CRON_LIST_SNAPSHOT_REVISION,
    total,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

function runsResult(entries: CronRunLogEntry[]): CronRunsResult {
  return {
    entries,
    total: entries.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function singleJobListCases(jobs: CronJob[], match: Record<string, unknown>) {
  return jobs.map((job, offset) => ({
    match: { ...match, offset },
    response: listResult([job], { total: jobs.length, limit: 1, offset }),
  }));
}

export function buildCronMocks(baseTime: number, options: { richAttention?: boolean } = {}) {
  const richAttention = options.richAttention === true;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const failedJob: CronJob = {
    id: "mock-cron-calendar-sync",
    agentId: "main",
    name: "Sync team calendar",
    description: "Refresh the shared calendar cache for the morning briefing.",
    enabled: true,
    createdAtMs: baseTime - 30 * day,
    updatedAtMs: baseTime - 4 * minute,
    schedule: { kind: "cron", expr: "0 */6 * * *", tz: "America/New_York" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Sync the team calendar and summarize schedule conflicts.",
    },
    delivery: { mode: "announce", channel: "telegram", to: "@operations" },
    state: {
      nextRunAtMs: baseTime + 5 * hour,
      lastRunAtMs: baseTime - 5 * minute,
      lastRunStatus: "error",
      lastError:
        "OAuth refresh failed: invalid_grant. The provider rejected the stored refresh token because it was revoked or expired. Reconnect Google Calendar before the next scheduled sync.",
      lastDurationMs: 8_420,
      consecutiveErrors: 2,
      lastDeliveryStatus: "not-requested",
    },
  };
  const extraFailedJobs: CronJob[] = richAttention
    ? [
        {
          id: "mock-cron-release-notify",
          agentId: "main",
          name: "Notify release stakeholders about deployment readiness and rollback constraints",
          description:
            "Send the release decision, deploy window, rollback owner, and incident contact to every stakeholder group.",
          enabled: true,
          createdAtMs: baseTime - 24 * day,
          updatedAtMs: baseTime - 7 * minute,
          schedule: { kind: "every", everyMs: 20 * minute, anchorMs: baseTime - 24 * day },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message:
              "Prepare the release notification, verify the rollback owner, and publish the final deployment readiness summary.",
          },
          delivery: { mode: "announce", channel: "slack", to: "#release-operations" },
          state: {
            nextRunAtMs: baseTime + 20 * minute,
            lastRunAtMs: baseTime - 9 * minute,
            lastRunStatus: "error",
            lastError:
              "Delivery failed after the provider accepted the request but closed the stream before the final acknowledgement. The retry queue retained the payload, the release channel has not been notified, and the notification fan-out must be reconciled before another deployment attempt.",
            lastDurationMs: 18_640,
            consecutiveErrors: 3,
            lastDeliveryStatus: "not-delivered",
          },
        },
        {
          id: "mock-cron-backup-verify",
          agentId: "main",
          name: "Verify encrypted backup rotation before the retention window closes",
          description:
            "Check the latest encrypted backup, key rotation receipt, and restore manifest before retention pruning.",
          enabled: true,
          createdAtMs: baseTime - 42 * day,
          updatedAtMs: baseTime - 11 * minute,
          schedule: { kind: "cron", expr: "15 * * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message:
              "Verify backup rotation and report any missing restore manifest or key receipt.",
          },
          delivery: { mode: "none" },
          state: {
            nextRunAtMs: baseTime + 15 * minute,
            lastRunAtMs: baseTime - 13 * minute,
            lastRunStatus: "error",
            lastError:
              "Restore verification could not read the encrypted manifest: checksum mismatch after the object store returned a partial range. Keep the current backup, do not prune the retention window, and retry after the storage replica is healthy.",
            lastDurationMs: 42_900,
            consecutiveErrors: 4,
            lastDeliveryStatus: "not-requested",
          },
        },
      ]
    : [];
  const overdueJob: CronJob = {
    id: "mock-cron-inbox-triage",
    agentId: "main",
    name: "Triage support inbox",
    description: "Classify new support mail and prepare the daily response queue.",
    enabled: true,
    createdAtMs: baseTime - 18 * day,
    updatedAtMs: baseTime - 35 * minute,
    schedule: { kind: "every", everyMs: 15 * minute, anchorMs: baseTime - 18 * day },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Triage the support inbox." },
    delivery: { mode: "none" },
    state: {
      nextRunAtMs: baseTime - 20 * minute,
      lastRunAtMs: baseTime - 35 * minute,
      lastRunStatus: "ok",
      lastDurationMs: 24_180,
      lastDeliveryStatus: "not-requested",
    },
  };
  const extraOverdueJobs: CronJob[] = richAttention
    ? [
        {
          id: "mock-cron-security-digest",
          agentId: "main",
          name: "Prepare the daily security digest",
          description: "Summarize new security advisories and unresolved remediation work.",
          enabled: true,
          createdAtMs: baseTime - 31 * day,
          updatedAtMs: baseTime - 50 * minute,
          schedule: { kind: "every", everyMs: hour, anchorMs: baseTime - 31 * day },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Prepare the daily security digest." },
          delivery: { mode: "none" },
          state: {
            nextRunAtMs: baseTime - 42 * minute,
            lastRunAtMs: baseTime - 102 * minute,
            lastRunStatus: "ok",
            lastDurationMs: 38_420,
            lastDeliveryStatus: "not-requested",
          },
        },
      ]
    : [];
  const healthyJob: CronJob = {
    id: "mock-cron-release-digest",
    agentId: "main",
    name: "Publish release digest",
    description: "Summarize merged changes for the engineering channel.",
    enabled: true,
    createdAtMs: baseTime - 9 * day,
    updatedAtMs: baseTime - 30 * minute,
    schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "America/New_York" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Draft and publish the release digest." },
    delivery: { mode: "announce", channel: "slack", to: "#engineering" },
    state: {
      nextRunAtMs: baseTime + 30 * minute,
      lastRunAtMs: baseTime - 30 * minute,
      lastRunStatus: "ok",
      lastDurationMs: 51_230,
      lastDelivered: true,
      lastDeliveryStatus: "delivered",
    },
  };
  const jobs = [overdueJob, ...extraOverdueJobs, healthyJob, failedJob, ...extraFailedJobs];
  const failedJobs = [failedJob, ...extraFailedJobs];
  const failedRuns: CronRunLogEntry[] = failedJobs.map((job, index) => ({
    ts: baseTime - (5 + index * 4) * minute,
    runAtMs: baseTime - (5 + index * 4) * minute,
    jobId: job.id,
    jobName: job.name,
    action: "finished",
    status: "error",
    durationMs: job.state?.lastDurationMs,
    error: job.state?.lastError,
    deliveryStatus: "not-requested",
    model: index === 1 ? "claude-sonnet-4-6" : "gpt-5.6-sol",
    provider: index === 1 ? "anthropic" : "openai",
  }));
  const runs: CronRunLogEntry[] = [
    ...failedRuns,
    {
      ts: baseTime - 30 * minute,
      runAtMs: baseTime - 30 * minute,
      jobId: healthyJob.id,
      jobName: healthyJob.name,
      action: "finished",
      status: "ok",
      durationMs: healthyJob.state?.lastDurationMs,
      summary: "Published a digest covering 14 merged changes.",
      delivered: true,
      deliveryStatus: "delivered",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    },
    {
      ts: baseTime - 35 * minute,
      runAtMs: baseTime - 35 * minute,
      jobId: overdueJob.id,
      jobName: overdueJob.name,
      action: "finished",
      status: "ok",
      durationMs: overdueJob.state?.lastDurationMs,
      summary: "Classified 23 messages and prepared 6 replies.",
      deliveryStatus: "not-requested",
      model: "gpt-5.6-sol",
      provider: "openai",
    },
  ];
  const queuedRuns: Array<{ runId: string; entry: CronRunLogEntry }> = jobs.map((job, index) => ({
    runId: `mock-cron-manual-${job.id}`,
    entry: {
      ts: baseTime + index,
      runAtMs: baseTime + index,
      jobId: job.id,
      jobName: job.name,
      action: "finished",
      status: "ok",
      durationMs: 42_000 + index * 2_500,
      summary: `Completed an on-demand run for ${job.name}.`,
      deliveryStatus: "not-requested",
      model: "gpt-5.6-sol",
      provider: "openai",
    },
  }));
  const status: CronStatus = {
    enabled: true,
    triggersEnabled: true,
    jobs: jobs.length,
    nextWakeAtMs: Math.min(
      ...jobs.flatMap((job) =>
        job.state?.nextRunAtMs === undefined ? [] : [job.state.nextRunAtMs],
      ),
    ),
  };
  const runByJobId = new Map(runs.map((entry) => [entry.jobId, entry]));
  const sortedJobLists = [
    {
      match: { sortBy: "nextRunAtMs", sortDir: "asc" },
      jobs: jobs.toSorted(
        (left, right) => (left.state?.nextRunAtMs ?? 0) - (right.state?.nextRunAtMs ?? 0),
      ),
    },
    {
      match: { sortBy: "nextRunAtMs", sortDir: "desc" },
      jobs: jobs.toSorted(
        (left, right) => (right.state?.nextRunAtMs ?? 0) - (left.state?.nextRunAtMs ?? 0),
      ),
    },
    {
      match: { sortBy: "updatedAtMs", sortDir: "asc" },
      jobs: jobs.toSorted((left, right) => (left.updatedAtMs ?? 0) - (right.updatedAtMs ?? 0)),
    },
    {
      match: { sortBy: "updatedAtMs", sortDir: "desc" },
      jobs: jobs.toSorted((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)),
    },
    {
      match: { sortBy: "name", sortDir: "asc" },
      jobs: jobs.toSorted((left, right) => left.name.localeCompare(right.name)),
    },
    {
      match: { sortBy: "name", sortDir: "desc" },
      jobs: jobs.toSorted((left, right) => right.name.localeCompare(left.name)),
    },
  ];

  return {
    "cron.status": status,
    "cron.list": {
      // Cases mirror the concrete queries today's Cron UI issues. Unknown combinations fall back
      // to the full fixture list; dynamic evaluation is intentionally out of scope because the
      // scenario is JSON-serialized into the page rather than installed as a live responder.
      cases: [
        {
          match: { enabled: "enabled", lastRunStatus: "error" },
          response: listResult(failedJobs, { limit: failedJobs.length }),
        },
        { match: { enabled: "disabled" }, response: listResult([]) },
        ...singleJobListCases(jobs, {
          enabled: "enabled",
          sortBy: "nextRunAtMs",
          sortDir: "asc",
          limit: 1,
        }),
        ...singleJobListCases(jobs, { includeDisabled: true, limit: 1 }),
        ...sortedJobLists.map((entry) => ({
          match: entry.match,
          response: listResult(entry.jobs),
        })),
        { response: listResult(jobs) },
      ],
    },
    "cron.runs": {
      cases: [
        ...queuedRuns.map((run) => ({
          match: { runId: run.runId },
          response: runsResult([run.entry]),
        })),
        ...jobs.flatMap((job) => {
          const jobRun = runByJobId.get(job.id);
          return [
            {
              match: { scope: "job", id: job.id, statuses: ["error"] },
              response: runsResult(jobRun?.status === "error" ? [jobRun] : []),
            },
            {
              match: { scope: "job", id: job.id },
              response: runsResult(jobRun ? [jobRun] : []),
            },
          ];
        }),
        { match: { statuses: ["error"] }, response: runsResult(failedRuns) },
        { response: runsResult(runs) },
      ],
    },
    // Writes acknowledge the UI action but intentionally keep the fixture snapshot immutable.
    "cron.add": { id: "mock-cron-created" },
    "cron.update": { ok: true },
    "cron.remove": { ok: true },
    "cron.run": {
      cases: queuedRuns.map((run) => ({
        match: { id: run.entry.jobId },
        response: { ok: true, enqueued: true, runId: run.runId },
      })),
    },
  };
}
