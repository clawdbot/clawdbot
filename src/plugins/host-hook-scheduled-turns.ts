import { randomUUID } from "node:crypto";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  deletePluginSessionSchedulerJob,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import type {
  PluginSessionSchedulerJobHandle,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";

const log = createSubsystemLogger("plugins/host-scheduled-turns");
const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";

type ResolvedSessionTurnSchedule =
  | {
      kind: "cron";
      expr: string;
      tz?: string;
    }
  | {
      kind: "at";
      at: string;
    };

function resolveSchedule(
  params: PluginSessionTurnScheduleParams,
): ResolvedSessionTurnSchedule | undefined {
  const cron = normalizeOptionalString((params as { cron?: unknown }).cron);
  if (cron) {
    const tz = normalizeOptionalString((params as { tz?: unknown }).tz);
    return {
      kind: "cron",
      expr: cron,
      ...(tz ? { tz } : {}),
    };
  }
  if ("delayMs" in params) {
    if (!Number.isFinite(params.delayMs) || params.delayMs < 0) {
      return undefined;
    }
    const timestamp = Date.now() + Math.max(1, Math.floor(params.delayMs));
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    const at = new Date(timestamp);
    if (!Number.isFinite(at.getTime())) {
      return undefined;
    }
    return { kind: "at", at: at.toISOString() };
  }
  const rawAt = (params as { at?: unknown }).at;
  const at = rawAt instanceof Date ? rawAt : new Date(rawAt as string | number | Date);
  if (!Number.isFinite(at.getTime())) {
    return undefined;
  }
  return { kind: "at", at: at.toISOString() };
}

function resolveSessionTurnDeliveryMode(deliveryMode: unknown): "none" | "announce" | undefined {
  if (deliveryMode === undefined) {
    return undefined;
  }
  if (deliveryMode === "none" || deliveryMode === "announce") {
    return deliveryMode;
  }
  return undefined;
}

function formatScheduleLogContext(params: {
  pluginId: string;
  sessionKey?: string;
  name?: string;
  jobId?: string;
}): string {
  const parts = [`pluginId=${params.pluginId}`];
  if (params.sessionKey) {
    parts.push(`sessionKey=${params.sessionKey}`);
  }
  if (params.name) {
    parts.push(`name=${params.name}`);
  }
  if (params.jobId) {
    parts.push(`jobId=${params.jobId}`);
  }
  return parts.join(" ");
}

async function removeScheduledSessionTurn(params: {
  cron: CronServiceContract;
  jobId: string;
  pluginId: string;
  sessionKey?: string;
  name?: string;
}): Promise<boolean> {
  try {
    const result = await params.cron.remove(params.jobId);
    return didCronCleanupJob(result);
  } catch (error) {
    log.warn(
      `plugin session turn cleanup failed (${formatScheduleLogContext(params)}): ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

function didCronRemoveJob(value: unknown): boolean {
  return isCronRemoveResult(value) && value.ok && value.removed;
}

function didCronCleanupJob(value: unknown): boolean {
  return isCronRemoveResult(value) && value.ok;
}

const PLUGIN_CRON_RESERVED_DELIMITER = ":";

function resolvePluginSessionTurnTag(value: unknown): {
  tag?: string;
  invalid: boolean;
} {
  const tag = normalizeOptionalString(value);
  if (!tag) {
    return { invalid: false };
  }
  if (tag.includes(PLUGIN_CRON_RESERVED_DELIMITER)) {
    return { invalid: true };
  }
  return { tag, invalid: false };
}

export function buildPluginSchedulerCronName(params: {
  pluginId: string;
  sessionKey: string;
  tag?: string;
  uniqueId?: string;
}): string {
  const uniqueId = params.uniqueId ?? randomUUID();
  if (!params.tag) {
    return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}:${params.sessionKey}:${uniqueId}`;
  }
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:${uniqueId}`;
}

function buildPluginSchedulerTagPrefix(params: {
  pluginId: string;
  tag: string;
  sessionKey: string;
}): string {
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:`;
}

function isCronRemoveResult(
  value: unknown,
): value is Awaited<ReturnType<CronServiceContract["remove"]>> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { ok?: unknown }).ok === "boolean" &&
    typeof (value as { removed?: unknown }).removed === "boolean"
  );
}

async function listAllCronJobsForPluginTagCleanup(
  cron: CronServiceContract,
  query: string,
): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  let offset = 0;
  for (;;) {
    const listResult = await cron.listPage({
      includeDisabled: true,
      limit: 200,
      query,
      sortBy: "name",
      sortDir: "asc",
      ...(offset > 0 ? { offset } : {}),
    });
    jobs.push(...listResult.jobs);
    if (!listResult.hasMore) {
      return jobs;
    }
    if (listResult.nextOffset === null || listResult.nextOffset <= offset) {
      return jobs;
    }
    offset = listResult.nextOffset;
  }
}

export async function schedulePluginSessionTurn(params: {
  pluginId: string;
  pluginName?: string;
  origin?: PluginOrigin;
  schedule: PluginSessionTurnScheduleParams;
  shouldCommit?: () => boolean;
  cron?: CronServiceContract;
  ownerRegistry?: PluginRegistry;
}): Promise<PluginSessionSchedulerJobHandle | undefined> {
  if (params.origin !== "bundled") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.schedule.sessionKey);
  const message = normalizeOptionalString(params.schedule.message);
  if (!sessionKey || !message) {
    return undefined;
  }
  const cronSchedule = resolveSchedule(params.schedule);
  if (!cronSchedule) {
    return undefined;
  }
  const rawDeliveryMode = (params.schedule as { deliveryMode?: unknown }).deliveryMode;
  const deliveryMode = resolveSessionTurnDeliveryMode(rawDeliveryMode);
  const scheduleName = normalizeOptionalString(params.schedule.name);
  if (rawDeliveryMode !== undefined && !deliveryMode) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): unsupported deliveryMode`,
    );
    return undefined;
  }
  if (cronSchedule.kind === "cron" && params.schedule.deleteAfterRun === true) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): deleteAfterRun requires a one-shot schedule`,
    );
    return undefined;
  }
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.schedule.tag);
  if (invalidTag) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): tag contains reserved delimiter ":"`,
    );
    return undefined;
  }
  const cronDeliveryMode = deliveryMode ?? "announce";
  if (params.shouldCommit && !params.shouldCommit()) {
    return undefined;
  }
  if (!params.cron) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): cron service unavailable`,
    );
    return undefined;
  }
  const cron = params.cron;
  const cronJobName = buildPluginSchedulerCronName({
    pluginId: params.pluginId,
    sessionKey,
    ...(tag !== undefined ? { tag } : {}),
    ...(scheduleName ? { uniqueId: scheduleName } : {}),
  });
  const cronPayload: CronJobCreate["payload"] = {
    kind: "agentTurn",
    message,
  };
  let result: Awaited<ReturnType<CronServiceContract["add"]>>;
  try {
    result = await cron.add({
      name: cronJobName,
      enabled: true,
      schedule: cronSchedule,
      sessionTarget: `session:${sessionKey}`,
      payload: cronPayload,
      ...(params.schedule.agentId ? { agentId: params.schedule.agentId } : {}),
      deleteAfterRun: params.schedule.deleteAfterRun ?? cronSchedule.kind === "at",
      wakeMode: "now",
      delivery: {
        mode: cronDeliveryMode,
        ...(cronDeliveryMode === "announce" ? { channel: "last" } : {}),
      },
    });
  } catch (error) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        name: cronJobName,
      })}): ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
  const jobId = result.id;
  if (!jobId) {
    return undefined;
  }
  if (params.shouldCommit && !params.shouldCommit()) {
    const removed = await removeScheduledSessionTurn({
      cron,
      jobId,
      pluginId: params.pluginId,
      sessionKey,
      name: cronJobName,
    });
    if (!removed) {
      log.warn(
        `plugin session turn scheduling rollback failed (${formatScheduleLogContext({
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
          jobId,
        })}): failed to remove stale scheduled session turn`,
      );
    }
    return undefined;
  }
  const handle = registerPluginSessionSchedulerJob({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    ownerRegistry: params.ownerRegistry,
    job: {
      id: jobId,
      sessionKey,
      kind: "session-turn",
      cleanup: async () => {
        const removed = await removeScheduledSessionTurn({
          cron,
          jobId,
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
        });
        if (!removed) {
          throw new Error(`failed to remove scheduled session turn: ${jobId}`);
        }
      },
    },
  });
  return handle;
}

export async function unschedulePluginSessionTurnsByTag(params: {
  pluginId: string;
  origin?: PluginOrigin;
  cron?: CronServiceContract;
  request: PluginSessionTurnUnscheduleByTagParams;
}): Promise<PluginSessionTurnUnscheduleByTagResult> {
  if (params.origin !== "bundled") {
    return { removed: 0, failed: 0 };
  }
  const sessionKey = normalizeOptionalString(params.request.sessionKey);
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.request.tag);
  if (!sessionKey || !tag || invalidTag) {
    return { removed: 0, failed: 0 };
  }
  if (!params.cron) {
    log.warn("plugin session turn untag-list failed: cron service unavailable");
    return { removed: 0, failed: 1 };
  }
  const cron = params.cron;
  const namePrefix = buildPluginSchedulerTagPrefix({
    pluginId: params.pluginId,
    tag,
    sessionKey,
  });
  let jobs: CronJob[];
  try {
    jobs = await listAllCronJobsForPluginTagCleanup(cron, namePrefix);
  } catch (error) {
    log.warn(`plugin session turn untag-list failed: ${formatErrorMessage(error)}`);
    return { removed: 0, failed: 1 };
  }
  const candidates = jobs.filter((job) => {
    return job.name.startsWith(namePrefix) && job.sessionTarget === `session:${sessionKey}`;
  });
  let removed = 0;
  let failed = 0;
  for (const job of candidates) {
    const id = job.id.trim();
    if (!id) {
      continue;
    }
    try {
      const result = await cron.remove(id);
      if (didCronRemoveJob(result)) {
        removed += 1;
        deletePluginSessionSchedulerJob({
          pluginId: params.pluginId,
          jobId: id,
          sessionKey,
        });
      } else {
        failed += 1;
      }
    } catch (error) {
      log.warn(
        `plugin session turn untag-remove failed: id=${id} error=${formatErrorMessage(error)}`,
      );
      failed += 1;
    }
  }
  return { removed, failed };
}
