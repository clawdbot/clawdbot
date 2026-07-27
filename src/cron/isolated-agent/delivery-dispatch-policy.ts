/** Formatting, retry, and idempotency policy for direct cron delivery. */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { isSuppressedControlReplyText } from "../../gateway/control-reply-text.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { isProvenDeliveryNotSentError } from "../../infra/delivery-recovery.shared.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { retryAsync } from "../../infra/retry.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { createCronExecutionId } from "../run-id.js";
import { hasScheduledNextRunAtMs } from "../service/jobs.js";
import type { CronJob } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { cleanupCronRunSessionAfterRun } from "./session-cleanup.js";

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

/** Deletes or retires ephemeral direct-delivery cron sessions for delete-after-run jobs. */
export async function cleanupDirectCronSession(params: {
  job: CronJob;
  agentSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeSessionDelete?: () => void;
  retireReason: string;
}): Promise<void> {
  await cleanupCronRunSessionAfterRun({
    job: params.job,
    agentSessionKey: params.agentSessionKey,
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
    sessionUpdatedAt: params.sessionUpdatedAt,
    beforeDelete: params.beforeSessionDelete,
    reason: params.retireReason,
  });
}

export function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

type NormalizedSilentReplyText = {
  text: string | undefined;
  strippedTrailingSilentToken: boolean;
};

export function normalizeSilentReplyText(text: string | undefined): NormalizedSilentReplyText {
  if (!text) {
    return { text, strippedTrailingSilentToken: false };
  }
  if (isSuppressedControlReplyText(text)) {
    return { text: undefined, strippedTrailingSilentToken: false };
  }

  let next = text;
  const hasLeadingSilentToken = startsWithSilentToken(next, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    next = stripLeadingSilentToken(next, SILENT_REPLY_TOKEN);
  }

  let strippedTrailingSilentToken = false;
  if (hasLeadingSilentToken || next.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    const trimmedBefore = next.trim();
    const stripped = stripSilentToken(next, SILENT_REPLY_TOKEN);
    strippedTrailingSilentToken = stripped !== trimmedBefore;
    next = stripped;
  }

  if (!next.trim() || isSuppressedControlReplyText(next)) {
    return { text: undefined, strippedTrailingSilentToken };
  }
  return { text: next, strippedTrailingSilentToken };
}

/** Returns whether cron delivery should tolerate per-payload send failures. */
export function resolveCronDeliveryBestEffort(job: CronJob): boolean {
  return job.delivery?.bestEffort === true;
}

/** Successful delivery-target resolution consumed by announce/direct delivery dispatch. */
const PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

const STALE_CRON_DELIVERY_MAX_START_DELAY_MS = 3 * 60 * 60_000;

type CompletedDirectCronDelivery = {
  ts: number;
  results: OutboundDeliveryResult[];
};

const deliveryLoggerRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-logger.runtime.js"),
);
const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));
const deliverySubagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-subagent-registry.runtime.js"),
);

const COMPLETED_DIRECT_CRON_DELIVERIES = new Map<string, CompletedDirectCronDelivery>();

async function loadDeliveryLoggerRuntime(): Promise<typeof import("./delivery-logger.runtime.js")> {
  return await deliveryLoggerRuntimeLoader.load();
}

async function loadTtsRuntime(): Promise<typeof import("../../tts/tts.runtime.js")> {
  return await ttsRuntimeLoader.load();
}

export async function loadDeliverySubagentRegistryRuntime(): Promise<
  typeof import("./delivery-subagent-registry.runtime.js")
> {
  return await deliverySubagentRegistryRuntimeLoader.load();
}

export async function logCronDeliveryWarn(message: string): Promise<void> {
  const { logWarn } = await loadDeliveryLoggerRuntime();
  logWarn(message);
}

export async function logCronDeliveryError(message: string): Promise<void> {
  const { logError } = await loadDeliveryLoggerRuntime();
  logError(message);
}

export function logCronDeliveryErrorDeferred(message: string): void {
  void loadDeliveryLoggerRuntime().then(({ logError }) => {
    logError(message);
  });
}

function cloneDeliveryResults(
  results: readonly OutboundDeliveryResult[],
): OutboundDeliveryResult[] {
  return results.map((result) => ({
    ...result,
    ...(result.meta ? { meta: { ...result.meta } } : {}),
  }));
}

function pruneCompletedDirectCronDeliveries(now: number) {
  const ttlMs = isFastTestRuntimeEnv() ? 60_000 : 24 * 60 * 60 * 1000;
  for (const [key, entry] of COMPLETED_DIRECT_CRON_DELIVERIES) {
    if (now - entry.ts >= ttlMs) {
      COMPLETED_DIRECT_CRON_DELIVERIES.delete(key);
    }
  }
  const maxEntries = 2000;
  if (COMPLETED_DIRECT_CRON_DELIVERIES.size <= maxEntries) {
    return;
  }
  const entries = [...COMPLETED_DIRECT_CRON_DELIVERIES.entries()].toSorted(
    (a, b) => a[1].ts - b[1].ts,
  );
  const toDelete = COMPLETED_DIRECT_CRON_DELIVERIES.size - maxEntries;
  for (let i = 0; i < toDelete; i += 1) {
    const oldest = entries[i];
    if (!oldest) {
      break;
    }
    COMPLETED_DIRECT_CRON_DELIVERIES.delete(oldest[0]);
  }
}

export function resolveCronDeliveryScheduledAtMs(params: {
  job: CronJob;
  runStartedAt: number;
}): number {
  const scheduledAt = params.job.state?.nextRunAtMs;
  return hasScheduledNextRunAtMs(scheduledAt) ? scheduledAt : params.runStartedAt;
}

export function resolveCronDeliveryStartDelayMs(params: {
  job: CronJob;
  runStartedAt: number;
}): number {
  return params.runStartedAt - resolveCronDeliveryScheduledAtMs(params);
}

export function isStaleCronDelivery(params: { job: CronJob; runStartedAt: number }): boolean {
  return resolveCronDeliveryStartDelayMs(params) > STALE_CRON_DELIVERY_MAX_START_DELAY_MS;
}

export function rememberCompletedDirectCronDelivery(
  idempotencyKey: string,
  results: readonly OutboundDeliveryResult[],
) {
  // Cache completed sends by idempotency key so retry paths can report the
  // original delivery result instead of double-announcing a cron run.
  const now = Date.now();
  COMPLETED_DIRECT_CRON_DELIVERIES.set(idempotencyKey, {
    ts: now,
    results: cloneDeliveryResults(results),
  });
  pruneCompletedDirectCronDeliveries(now);
}

export function getCompletedDirectCronDelivery(
  idempotencyKey: string,
): OutboundDeliveryResult[] | undefined {
  const now = Date.now();
  pruneCompletedDirectCronDeliveries(now);
  const cached = COMPLETED_DIRECT_CRON_DELIVERIES.get(idempotencyKey);
  if (!cached) {
    return undefined;
  }
  return cloneDeliveryResults(cached.results);
}

export async function maybeApplyTtsToCronPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  delivery: SuccessfulDeliveryTarget;
  agentId: string;
  ttsAuto?: TtsAutoMode;
}): Promise<ReplyPayload[]> {
  if (
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      ttsAuto: params.ttsAuto,
      agentId: params.agentId,
      channelId: params.delivery.channel,
      accountId: params.delivery.accountId,
    })
  ) {
    return params.payloads;
  }
  const { maybeApplyTtsToPayload } = await loadTtsRuntime();
  return await Promise.all(
    params.payloads.map((payload) =>
      maybeApplyTtsToPayload({
        payload,
        cfg: params.cfg,
        channel: params.delivery.channel,
        kind: "final",
        ttsAuto: params.ttsAuto,
        agentId: params.agentId,
        accountId: params.delivery.accountId,
      }),
    ),
  );
}

export function buildDirectCronDeliveryIdempotencyKey(params: {
  jobId: string;
  runStartedAt: number;
  delivery: SuccessfulDeliveryTarget;
}): string {
  // Include route identity, not just the cron execution id, because one run can
  // target different channels/accounts/threads across retry and fallback paths.
  const executionId = createCronExecutionId(params.jobId, params.runStartedAt);
  const threadId =
    params.delivery.threadId == null || params.delivery.threadId === ""
      ? ""
      : (stringifyRouteThreadId(params.delivery.threadId) ?? "");
  const accountId = params.delivery.accountId?.trim() ?? "";
  const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
  return `cron-direct-delivery:v1:${executionId}:${params.delivery.channel}:${accountId}:${normalizedTo}:${threadId}`;
}

/** Clears the direct-delivery idempotency cache for deterministic tests. */
function resetCompletedDirectCronDeliveriesForTests() {
  COMPLETED_DIRECT_CRON_DELIVERIES.clear();
}

/** Returns the direct-delivery idempotency cache size for tests. */
function getCompletedDirectCronDeliveriesCountForTests(): number {
  return COMPLETED_DIRECT_CRON_DELIVERIES.size;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronDeliveryDispatchTestApi")] =
    {
      resetCompletedDirectCronDeliveriesForTests,
      getCompletedDirectCronDeliveriesCountForTests,
    };
}

function summarizeDirectCronDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function isTransientDirectCronDeliveryError(error: unknown): boolean {
  const message = summarizeDirectCronDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return isProvenDeliveryNotSentError(error);
}
function resolveDirectCronRetryDelaysMs(): readonly number[] {
  return isFastTestRuntimeEnv() ? [0, 0, 0] : [5_000, 10_000, 20_000];
}

export async function retryTransientDirectCronDelivery<T>(params: {
  jobId: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
  shouldRetryError?: (err: unknown) => boolean;
}): Promise<T> {
  const retryDelaysMs = resolveDirectCronRetryDelaysMs();
  if (params.signal?.aborted) {
    throw new Error("cron delivery aborted");
  }
  const runWithAbortCheck = async () => {
    if (params.signal?.aborted) {
      throw new Error("cron delivery aborted");
    }
    return await params.run();
  };
  return await retryAsync(runWithAbortCheck, {
    attempts: retryDelaysMs.length + 1,
    minDelayMs: 0,
    maxDelayMs: Math.max(...retryDelaysMs),
    delayMs: ({ attempt }) => retryDelaysMs[attempt - 1] ?? 0,
    shouldRetry: (err) =>
      params.signal?.aborted !== true &&
      isTransientDirectCronDeliveryError(err) &&
      (params.shouldRetryError?.(err) ?? true),
    onRetry: async ({ attempt, maxAttempts, delayMs, err }) => {
      await logCronDeliveryWarn(
        `[cron:${params.jobId}] transient direct announce delivery failure, retrying ${attempt + 1}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDirectCronDeliveryError(err)}`,
      );
      if (delayMs === 0) {
        await sleepWithAbort(0, params.signal);
      }
    },
    sleep: async (delayMs) => await sleepWithAbort(delayMs, params.signal),
  });
}
