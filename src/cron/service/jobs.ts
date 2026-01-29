import crypto from "node:crypto";

import { computeNextRunAtMs } from "../schedule.js";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
} from "../types.js";
import {
  normalizeOptionalAgentId,
  normalizeOptionalText,
  normalizePayloadToSystemText,
  normalizeRequiredName,
} from "./normalize.js";
import type { CronServiceState } from "./state.js";

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

export function assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">) {
  if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (job.sessionTarget === "isolated" && job.payload.kind !== "agentTurn") {
    throw new Error('isolated cron jobs require payload.kind="agentTurn"');
  }
}

export function findJobOrThrow(state: CronServiceState, id: string) {
  const job = state.store?.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`unknown cron job id: ${id}`);
  return job;
}

export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) return undefined;
  if (job.schedule.kind === "at") {
    // One-shot jobs stay due until they successfully finish.
    if (job.state.lastStatus === "ok" && job.state.lastRunAtMs) return undefined;
    return job.schedule.atMs;
  }
  // For "every" jobs, anchor to lastRunAtMs to prevent drift on updates/restarts
  if (job.schedule.kind === "every") {
    const anchor = job.state.lastRunAtMs ?? job.schedule.anchorMs ?? nowMs;
    return computeNextRunAtMs({ ...job.schedule, anchorMs: anchor }, nowMs);
  }
  // "cron" expressions are clock-based
  return computeNextRunAtMs(job.schedule, nowMs);
}

export function recomputeNextRuns(state: CronServiceState) {
  if (!state.store) return;
  const now = state.deps.nowMs();
  for (const job of state.store.jobs) {
    if (!job.state) job.state = {};
    if (!job.enabled) {
      job.state.nextRunAtMs = undefined;
      job.state.runningAtMs = undefined;
      continue;
    }
    const runningAt = job.state.runningAtMs;
    if (typeof runningAt === "number" && now - runningAt > STUCK_RUN_MS) {
      state.deps.log.warn(
        { jobId: job.id, runningAtMs: runningAt },
        "cron: clearing stuck running marker",
      );
      job.state.runningAtMs = undefined;
    }
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  }
}

export function nextWakeAtMs(state: CronServiceState) {
  const jobs = state.store?.jobs ?? [];
  const enabled = jobs.filter((j) => j.enabled && typeof j.state.nextRunAtMs === "number");
  if (enabled.length === 0) return undefined;
  return enabled.reduce(
    (min, j) => Math.min(min, j.state.nextRunAtMs as number),
    enabled[0].state.nextRunAtMs as number,
  );
}

export function createJob(state: CronServiceState, input: CronJobCreate): CronJob {
  const now = state.deps.nowMs();
  const id = crypto.randomUUID();
  const job: CronJob = {
    id,
    agentId: normalizeOptionalAgentId(input.agentId),
    name: normalizeRequiredName(input.name),
    description: normalizeOptionalText(input.description),
    enabled: input.enabled !== false,
    deleteAfterRun: input.deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: input.schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload: input.payload,
    isolation: input.isolation,
    state: {
      ...input.state,
    },
  };
  assertSupportedJobSpec(job);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

export function applyJobPatch(job: CronJob, patch: CronJobPatch) {
  if ("name" in patch) job.name = normalizeRequiredName(patch.name);
  if ("description" in patch) job.description = normalizeOptionalText(patch.description);
  if (typeof patch.enabled === "boolean") job.enabled = patch.enabled;
  if (typeof patch.deleteAfterRun === "boolean") job.deleteAfterRun = patch.deleteAfterRun;
  if (patch.schedule) job.schedule = patch.schedule;
  if (patch.sessionTarget) job.sessionTarget = patch.sessionTarget;
  if (patch.wakeMode) job.wakeMode = patch.wakeMode;
  if (patch.payload) job.payload = mergeCronPayload(job.payload, patch.payload);
  if (patch.isolation) job.isolation = patch.isolation;
  if (patch.state) job.state = { ...job.state, ...patch.state };
  if ("agentId" in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  assertSupportedJobSpec(job);
}

function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === "systemEvent") {
    if (existing.kind !== "systemEvent") {
      return buildPayloadFromPatch(patch);
    }
    const text = typeof patch.text === "string" ? patch.text : existing.text;
    return { kind: "systemEvent", text };
  }

  if (existing.kind !== "agentTurn") {
    return buildPayloadFromPatch(patch);
  }

  const next: Extract<CronPayload, { kind: "agentTurn" }> = { ...existing };
  if (typeof patch.message === "string") next.message = patch.message;
  if (typeof patch.model === "string") next.model = patch.model;
  if (typeof patch.thinking === "string") next.thinking = patch.thinking;
  if (typeof patch.timeoutSeconds === "number") next.timeoutSeconds = patch.timeoutSeconds;
  if (typeof patch.deliver === "boolean") next.deliver = patch.deliver;
  if (typeof patch.channel === "string") next.channel = patch.channel;
  if (typeof patch.to === "string") next.to = patch.to;
  if (typeof patch.bestEffortDeliver === "boolean") {
    next.bestEffortDeliver = patch.bestEffortDeliver;
  }
  return next;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "systemEvent") {
    if (typeof patch.text !== "string" || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    return { kind: "systemEvent", text: patch.text };
  }

  if (typeof patch.message !== "string" || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  return {
    kind: "agentTurn",
    message: patch.message,
    model: patch.model,
    thinking: patch.thinking,
    timeoutSeconds: patch.timeoutSeconds,
    deliver: patch.deliver,
    channel: patch.channel,
    to: patch.to,
    bestEffortDeliver: patch.bestEffortDeliver,
  };
}

export function isJobDue(job: CronJob, nowMs: number, opts: { forced: boolean }) {
  if (opts.forced) return true;
  return job.enabled && typeof job.state.nextRunAtMs === "number" && nowMs >= job.state.nextRunAtMs;
}

export function resolveJobPayloadTextForMain(job: CronJob): string | undefined {
  if (job.payload.kind !== "systemEvent") return undefined;
  const text = normalizePayloadToSystemText(job.payload);
  return text.trim() ? text : undefined;
}
