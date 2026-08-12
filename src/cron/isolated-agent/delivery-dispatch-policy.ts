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
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
} from "../../infra/delivery-queue-sqlite.js";
import { isProvenDeliveryNotSentError } from "../../infra/delivery-recovery.shared.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../../infra/outbound/delivery-queue-media-staging.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { retryAsync } from "../../infra/retry.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { createCronExecutionId } from "../run-id.js";
import { hasScheduledNextRunAtMs } from "../service/jobs-scheduling.js";
import type { CronJob } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

export const DIRECT_CRON_DELIVERY_COMPLETION_RETENTION = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const satisfies DeliveryQueueCompletionRetention;

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

const deliveryLoggerRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-logger.runtime.js"),
);
const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));
const deliverySubagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-subagent-registry.runtime.js"),
);

export async function loadDeliverySubagentRegistryRuntime(): Promise<
  typeof import("./delivery-subagent-registry.runtime.js")
> {
  return await deliverySubagentRegistryRuntimeLoader.load();
}

export async function logCronDeliveryWarn(message: string): Promise<void> {
  const { logWarn } = await deliveryLoggerRuntimeLoader.load();
  logWarn(message);
}

export async function logCronDeliveryError(message: string): Promise<void> {
  const { logError } = await deliveryLoggerRuntimeLoader.load();
  logError(message);
}

export function logCronDeliveryErrorDeferred(message: string): void {
  void deliveryLoggerRuntimeLoader.load().then(({ logError }) => {
    logError(message);
  });
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
  const { maybeApplyTtsToPayload } = await ttsRuntimeLoader.load();
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
  // Escape route fields independently so colon-bearing identities cannot
  // collide while ordinary shipped channel and target keys stay unchanged.
  const routeIdentity = [params.delivery.channel, accountId, normalizedTo, threadId]
    .map(encodeURIComponent)
    .join(":");
  return `${DIRECT_CRON_DELIVERY_COMPLETION_RETENTION.idPrefix}${executionId}:${routeIdentity}`;
}

/** Receipts own recipient delivery; projections never stand in for custody. */
export function isCompletedDirectCronDelivery(id: string): boolean {
  return getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id) === "completed";
}

/** Wait only for an active recipient owner, never for crashed ambiguous sends. */
export async function waitForCompletedDirectCronDelivery(params: {
  id: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  // SQLite producer leases fence cross-process sends for at most 30 seconds.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, params.id);
    if (status === "completed") {
      return true;
    }
    const owner =
      status === "pending" ? loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, params.id) : null;
    if (!owner && status === "pending") {
      // Completion can replace a pending row between the two indexed reads.
      return isCompletedDirectCronDelivery(params.id);
    }
    if (
      !owner ||
      (owner.recoveryState === "send_attempt_started"
        ? typeof owner.platformSendStartedAt !== "number" ||
          owner.platformSendStartedAt <= Date.now() - 30_000
        : owner.recoveryState !== "producer_claimed" ||
          typeof owner.availableAt !== "number" ||
          owner.availableAt <= Date.now())
    ) {
      return false;
    }
    if (attempt < 119) {
      await sleepWithAbort(250, params.signal);
    }
  }
  return false;
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
  label?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  run: () => Promise<T>;
  shouldRetryError?: (err: unknown) => boolean;
}): Promise<T> {
  const retryDelaysMs = resolveDirectCronRetryDelaysMs();
  const assertActive = () => {
    if (params.signal?.aborted) {
      throw new Error("cron delivery aborted");
    }
    if (params.deadlineAtMs !== undefined && Date.now() >= params.deadlineAtMs) {
      const error = new Error("cron delivery deadline exceeded");
      error.name = "TimeoutError";
      throw error;
    }
  };
  assertActive();
  const runWithAbortCheck = async () => {
    assertActive();
    return await params.run();
  };
  const result = await retryAsync(runWithAbortCheck, {
    attempts: retryDelaysMs.length + 1,
    minDelayMs: 0,
    maxDelayMs: Math.max(...retryDelaysMs),
    delayMs: ({ attempt }) => retryDelaysMs[attempt - 1] ?? 0,
    shouldRetry: (err) =>
      params.signal?.aborted !== true &&
      (params.deadlineAtMs === undefined || Date.now() < params.deadlineAtMs) &&
      isTransientDirectCronDeliveryError(err) &&
      (params.shouldRetryError?.(err) ?? true),
    onRetry: async ({ attempt, maxAttempts, delayMs, err }) => {
      await logCronDeliveryWarn(
        `[cron:${params.jobId}] transient ${params.label ?? "direct announce"} delivery failure, retrying ${attempt + 1}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDirectCronDeliveryError(err)}`,
      );
      if (delayMs === 0) {
        await sleepWithAbort(0, params.signal);
      }
    },
    sleep: async (delayMs) => {
      const remainingMs =
        params.deadlineAtMs === undefined ? delayMs : Math.max(0, params.deadlineAtMs - Date.now());
      await sleepWithAbort(Math.min(delayMs, remainingMs), params.signal);
      assertActive();
    },
  });
  return result;
}
