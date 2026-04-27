import { retireSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../auto-reply/tokens.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createCronExecutionId } from "../run-id.js";
import { hasScheduledNextRunAtMs } from "../service/jobs.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickLastNonEmptyTextFromPayloads, pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

type NormalizedSilentReplyText = {
  text: string | undefined;
  strippedTrailingSilentToken: boolean;
};

function normalizeSilentReplyText(text: string | undefined): NormalizedSilentReplyText {
  if (!text) {
    return { text, strippedTrailingSilentToken: false };
  }
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
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

  if (!next.trim() || isSilentReplyText(next, SILENT_REPLY_TOKEN)) {
    return { text: undefined, strippedTrailingSilentToken };
  }
  return { text: next, strippedTrailingSilentToken };
}

export function matchesMessagingToolDeliveryTarget(
  target: { provider?: string; to?: string; accountId?: string },
  delivery: { channel?: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = normalizeLowercaseStringOrEmpty(delivery.channel);
  const provider = normalizeOptionalLowercaseString(target.provider);
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (delivery.accountId && target.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  // Strip :topic:NNN from message targets and normalize Feishu/Lark prefixes on
  // both sides so cron duplicate suppression compares canonical IDs.
  const normalizedTargetTo = normalizeDeliveryTarget(channel, target.to.replace(/:topic:\d+$/, ""));
  const normalizedDeliveryTo = normalizeDeliveryTarget(channel, delivery.to);
  return normalizedTargetTo === normalizedDeliveryTo;
}

export function resolveCronDeliveryBestEffort(job: CronJob): boolean {
  return job.delivery?.bestEffort === true;
}

export type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

type DispatchCronDeliveryParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runSessionKey: string;
  sessionId: string;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  deliveryRequested: boolean;
  skipHeartbeatDelivery: boolean;
  skipMessagingToolDelivery?: boolean;
  unverifiedMessagingToolDelivery?: boolean;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  summary?: string;
  outputText?: string;
  telemetry?: CronRunTelemetry;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  abortReason: () => string;
  withRunSession: (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ) => RunCronAgentTurnResult;
};

export type DispatchCronDeliveryState = {
  result?: RunCronAgentTurnResult;
  delivered: boolean;
  deliveryAttempted: boolean;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
};

const TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

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

let gatewayCallRuntimePromise: Promise<typeof import("../../gateway/call.runtime.js")> | undefined;
let deliveryOutboundRuntimePromise:
  | Promise<typeof import("./delivery-outbound.runtime.js")>
  | undefined;
let deliverySubagentRegistryRuntimePromise:
  | Promise<typeof import("./delivery-subagent-registry.runtime.js")>
  | undefined;
let deliveryLoggerRuntimePromise:
  | Promise<typeof import("./delivery-logger.runtime.js")>
  | undefined;
let subagentFollowupRuntimePromise:
  | Promise<typeof import("./subagent-followup.runtime.js")>
  | undefined;

const COMPLETED_DIRECT_CRON_DELIVERIES = new Map<string, CompletedDirectCronDelivery>();

async function loadGatewayCallRuntime(): Promise<typeof import("../../gateway/call.runtime.js")> {
  gatewayCallRuntimePromise ??= import("../../gateway/call.runtime.js");
  return await gatewayCallRuntimePromise;
}

async function loadDeliveryOutboundRuntime(): Promise<
  typeof import("./delivery-outbound.runtime.js")
> {
  deliveryOutboundRuntimePromise ??= import("./delivery-outbound.runtime.js");
  return await deliveryOutboundRuntimePromise;
}

async function loadDeliverySubagentRegistryRuntime(): Promise<
  typeof import("./delivery-subagent-registry.runtime.js")
> {
  deliverySubagentRegistryRuntimePromise ??= import("./delivery-subagent-registry.runtime.js");
  return await deliverySubagentRegistryRuntimePromise;
}

async function loadDeliveryLoggerRuntime(): Promise<typeof import("./delivery-logger.runtime.js")> {
  deliveryLoggerRuntimePromise ??= import("./delivery-logger.runtime.js");
  return await deliveryLoggerRuntimePromise;
}

async function loadSubagentFollowupRuntime(): Promise<
  typeof import("./subagent-followup.runtime.js")
> {
  subagentFollowupRuntimePromise ??= import("./subagent-followup.runtime.js");
  return await subagentFollowupRuntimePromise;
}

async function logCronDeliveryWarn(message: string): Promise<void> {
  const { logWarn } = await loadDeliveryLoggerRuntime();
  logWarn(message);
}

async function logCronDeliveryError(message: string): Promise<void> {
  const { logError } = await loadDeliveryLoggerRuntime();
  logError(message);
}

function logCronDeliveryErrorDeferred(message: string): void {
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
  const ttlMs = process.env.OPENCLAW_TEST_FAST === "1" ? 60_000 : 24 * 60 * 60 * 1000;
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

function resolveCronDeliveryScheduledAtMs(params: { job: CronJob; runStartedAt: number }): number {
  const scheduledAt = params.job.state?.nextRunAtMs;
  return hasScheduledNextRunAtMs(scheduledAt) ? scheduledAt : params.runStartedAt;
}

function resolveCronDeliveryStartDelayMs(params: { job: CronJob; runStartedAt: number }): number {
  return params.runStartedAt - resolveCronDeliveryScheduledAtMs(params);
}

function isStaleCronDelivery(params: { job: CronJob; runStartedAt: number }): boolean {
  return resolveCronDeliveryStartDelayMs(params) > STALE_CRON_DELIVERY_MAX_START_DELAY_MS;
}

function rememberCompletedDirectCronDelivery(
  idempotencyKey: string,
  results: readonly OutboundDeliveryResult[],
) {
  const now = Date.now();
  COMPLETED_DIRECT_CRON_DELIVERIES.set(idempotencyKey, {
    ts: now,
    results: cloneDeliveryResults(results),
  });
  pruneCompletedDirectCronDeliveries(now);
}

function getCompletedDirectCronDelivery(
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

function buildDirectCronDeliveryIdempotencyKey(params: {
  jobId: string;
  runStartedAt: number;
  delivery: SuccessfulDeliveryTarget;
}): string {
  const executionId = createCronExecutionId(params.jobId, params.runStartedAt);
  const threadId =
    params.delivery.threadId == null || params.delivery.threadId === ""
      ? ""
      : String(params.delivery.threadId);
  const accountId = params.delivery.accountId?.trim() ?? "";
  const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
  return `cron-direct-delivery:v1:${executionId}:${params.delivery.channel}:${accountId}:${normalizedTo}:${threadId}`;
}

function shouldQueueCronAwareness(job: CronJob, deliveryBestEffort: boolean): boolean {
  // Keep issue #52136 scoped to isolated runs. Session-bound cron jobs keep
  // their existing behavior, and best-effort sends may only partially deliver.
  return job.sessionTarget === "isolated" && !deliveryBestEffort;
}

function resolveCronAwarenessMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return params.cfg.session?.scope === "global"
    ? resolveMainSessionKey(params.cfg)
    : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
}

async function queueCronAwarenessSystemEvent(params: {
  cfg: OpenClawConfig;
  jobId: string;
  agentId: string;
  deliveryIdempotencyKey: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads?: ReplyPayload[];
}): Promise<void> {
  const text = params.deliveryPayloads
    ? pickLastNonEmptyTextFromPayloads(params.deliveryPayloads)
    : (normalizeOptionalString(params.outputText) ??
      normalizeOptionalString(params.synthesizedText));
  if (!text) {
    return;
  }

  try {
    const { enqueueSystemEvent } = await loadDeliveryOutboundRuntime();
    enqueueSystemEvent(text, {
      sessionKey: resolveCronAwarenessMainSessionKey({
        cfg: params.cfg,
        agentId: params.agentId,
      }),
      contextKey: params.deliveryIdempotencyKey,
      trusted: false,
    });
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.jobId}] failed to queue isolated cron awareness for the main session: ${formatErrorMessage(err)}`,
    );
  }
}

export function resetCompletedDirectCronDeliveriesForTests() {
  COMPLETED_DIRECT_CRON_DELIVERIES.clear();
}

export function getCompletedDirectCronDeliveriesCountForTests(): number {
  return COMPLETED_DIRECT_CRON_DELIVERIES.size;
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
  return TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function resolveDirectCronRetryDelaysMs(): readonly number[] {
  return process.env.NODE_ENV === "test" && process.env.OPENCLAW_TEST_FAST === "1"
    ? [0, 0, 0]
    : [5_000, 10_000, 20_000];
}

async function retryTransientDirectCronDelivery<T>(params: {
  jobId: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectCronRetryDelaysMs();
  let retryIndex = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("cron delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs == null || !isTransientDirectCronDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      await logCronDeliveryWarn(
        `[cron:${params.jobId}] transient direct announce delivery failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDirectCronDeliveryError(err)}`,
      );
      retryIndex += 1;
      await sleepWithAbort(delayMs, params.signal);
    }
  }
}

export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const skipMessagingToolDelivery = params.skipMessagingToolDelivery === true;
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  // Shared callers can treat a matching message-tool send as the completed
  // delivery path. Cron-owned callers keep this false so direct cron delivery
  // remains the only source of delivered state.
  let delivered = skipMessagingToolDelivery;
  let deliveryAttempted = skipMessagingToolDelivery;
  let directCronSessionDeleted = false;
  const formatDeliveryTargetError = (error: string) =>
    params.unverifiedMessagingToolDelivery === true
      ? `${error}; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target`
      : error;
  const failDeliveryTarget = (error: string) =>
    params.withRunSession({
      status: "error",
      error: formatDeliveryTargetError(error),
      errorKind: "delivery-target",
      summary,
      outputText,
      deliveryAttempted,
      ...params.telemetry,
    });
  const cleanupDirectCronSessionIfNeeded = async (): Promise<void> => {
    if (!params.job.deleteAfterRun || directCronSessionDeleted) {
      return;
    }
    try {
      const { callGateway } = await loadGatewayCallRuntime();
      await callGateway({
        method: "sessions.delete",
        params: {
          key: params.agentSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        },
        timeoutMs: 10_000,
      });
      directCronSessionDeleted = true;
    } catch {
      await retireSessionMcpRuntime({
        sessionId: params.sessionId,
        reason: "cron-delete-after-run-fallback",
      });
      // Best-effort; direct delivery result should still be returned.
    }
  };
  const finishSilentReplyDelivery = async (): Promise<RunCronAgentTurnResult> => {
    deliveryAttempted = true;
    await cleanupDirectCronSessionIfNeeded();
    return params.withRunSession({
      status: "ok",
      summary,
      outputText,
      delivered: false,
      deliveryAttempted: true,
      ...params.telemetry,
    });
  };

  const deliverViaDirect = async (
    delivery: SuccessfulDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    const {
      buildOutboundSessionContext,
      createOutboundSendDeps,
      deliverOutboundPayloads,
      resolveAgentOutboundIdentity,
    } = await loadDeliveryOutboundRuntime();
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery,
    });
    try {
      const rawPayloads =
        deliveryPayloads.length > 0
          ? deliveryPayloads
          : synthesizedText
            ? [{ text: synthesizedText }]
            : [];
      const payloadsForDelivery = rawPayloads
        .map((p) => {
          if (!p.text) {
            return p;
          }
          const normalized = normalizeSilentReplyText(p.text);
          return Object.assign({}, p, {
            text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
          });
        })
        .filter((p) => hasReplyPayloadContent(p, { trimText: true }));
      if (payloadsForDelivery.length === 0) {
        return await finishSilentReplyDelivery();
      }
      if (params.isAborted()) {
        return params.withRunSession({
          status: "error",
          error: params.abortReason(),
          deliveryAttempted,
          ...params.telemetry,
        });
      }
      if (
        params.deliveryRequested &&
        isStaleCronDelivery({
          job: params.job,
          runStartedAt: params.runStartedAt,
        })
      ) {
        deliveryAttempted = true;
        const nowMs = Date.now();
        const scheduledAtMs = resolveCronDeliveryScheduledAtMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        const startDelayMs = resolveCronDeliveryStartDelayMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        await logCronDeliveryWarn(
          `[cron:${params.job.id}] skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 60_000)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 60_000)}m`,
        );
        return params.withRunSession({
          status: "ok",
          summary,
          outputText,
          deliveryAttempted,
          delivered: false,
          ...params.telemetry,
        });
      }
      deliveryAttempted = true;
      const cachedResults = getCompletedDirectCronDelivery(deliveryIdempotencyKey);
      if (cachedResults) {
        // Cached entries are only recorded after a successful non-empty delivery.
        delivered = true;
        return null;
      }
      const deliverySession = buildOutboundSessionContext({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        sessionKey: params.agentSessionKey,
      });

      // Track bestEffort partial failures so we can log them and avoid
      // marking the job as delivered when payloads were silently dropped.
      let hadPartialFailure = false;
      const onError = params.deliveryBestEffort
        ? (err: unknown, _payload: unknown) => {
            hadPartialFailure = true;
            logCronDeliveryErrorDeferred(
              `[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
            );
          }
        : undefined;

      const runDelivery = async () =>
        await deliverOutboundPayloads({
          cfg: params.cfgWithAgentDefaults,
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
          payloads: payloadsForDelivery,
          session: deliverySession,
          identity,
          bestEffort: params.deliveryBestEffort,
          deps: createOutboundSendDeps(params.deps),
          abortSignal: params.abortSignal,
          onError,
          // Isolated cron direct delivery uses its own transient retry loop.
          // Keep all attempts out of the write-ahead delivery queue so a
          // late-successful first send cannot leave behind a failed queue
          // entry that replays on the next restart.
          // See: https://github.com/openclaw/openclaw/issues/40545
          skipQueue: true,
        });
      const deliveryResults = options?.retryTransient
        ? await retryTransientDirectCronDelivery({
            jobId: params.job.id,
            signal: params.abortSignal,
            run: runDelivery,
          })
        : await runDelivery();
      // Only mark delivered when ALL payloads succeeded (no partial failure).
      delivered = deliveryResults.length > 0 && !hadPartialFailure;
      // Intentionally leave partial success uncached: replay may duplicate the
      // successful subset, but caching it here would permanently drop the
      // failed payloads by converting the replay into delivered=true.
      if (delivered && shouldQueueCronAwareness(params.job, params.deliveryBestEffort)) {
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey,
          outputText,
          synthesizedText,
          deliveryPayloads: payloadsForDelivery,
        });
      }
      if (delivered) {
        rememberCompletedDirectCronDelivery(deliveryIdempotencyKey, deliveryResults);
      }
      return null;
    } catch (err) {
      if (!params.deliveryBestEffort) {
        return params.withRunSession({
          status: "error",
          summary,
          outputText,
          error: String(err),
          deliveryAttempted,
          ...params.telemetry,
        });
      }
      await logCronDeliveryError(
        `[cron:${params.job.id}] delivery failed (bestEffort): ${formatErrorMessage(err)}`,
      );
      return null;
    }
  };

  const deliverViaDirectAndCleanup = async (
    delivery: SuccessfulDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    try {
      return await deliverViaDirect(delivery, options);
    } finally {
      await cleanupDirectCronSessionIfNeeded();
    }
  };

  const finalizeTextDelivery = async (
    delivery: SuccessfulDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (!synthesizedText) {
      return null;
    }
    const initialSynthesizedText = synthesizedText.trim();
    const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
    const subagentRegistryRuntime = await loadDeliverySubagentRegistryRuntime();
    const subagentFollowupSessionKey = params.runSessionKey;
    let activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
      subagentFollowupSessionKey,
    );
    const shouldCheckCompletedDescendants =
      activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText);
    const needsSubagentFollowupRuntime =
      shouldCheckCompletedDescendants || activeSubagentRuns > 0 || expectedSubagentFollowup;
    const subagentFollowupRuntime = needsSubagentFollowupRuntime
      ? await loadSubagentFollowupRuntime()
      : undefined;
    // Also check for already-completed descendants. If the subagent finished
    // before delivery-dispatch runs, activeSubagentRuns is 0 and
    // expectedSubagentFollowup may be false (e.g. cron said "on it" which
    // doesn't match the narrow hint list). We still need to use the
    // descendant's output instead of the interim cron text.
    const completedDescendantReply = shouldCheckCompletedDescendants
      ? await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        })
      : undefined;
    const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
    if (activeSubagentRuns > 0 || expectedSubagentFollowup) {
      let finalReply = await subagentFollowupRuntime?.waitForDescendantSubagentSummary({
        sessionKey: subagentFollowupSessionKey,
        initialReply: initialSynthesizedText,
        timeoutMs: params.timeoutMs,
        observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
      });
      activeSubagentRuns = subagentRegistryRuntime.countActiveDescendantRuns(
        subagentFollowupSessionKey,
      );
      if (!finalReply && activeSubagentRuns === 0) {
        finalReply = await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          sessionKey: subagentFollowupSessionKey,
          runStartedAt: params.runStartedAt,
        });
      }
      if (finalReply && activeSubagentRuns === 0) {
        outputText = finalReply;
        summary = pickSummaryFromOutput(finalReply) ?? summary;
        synthesizedText = finalReply;
        deliveryPayloads = [{ text: finalReply }];
      }
    } else if (completedDescendantReply) {
      // Descendants already finished before we got here. Use their output
      // directly instead of the cron agent's interim text.
      outputText = completedDescendantReply;
      summary = pickSummaryFromOutput(completedDescendantReply) ?? summary;
      synthesizedText = completedDescendantReply;
      deliveryPayloads = [{ text: completedDescendantReply }];
    }
    if (activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // update to the main requester. Mark deliveryAttempted so the timer does
      // not fire a redundant enqueueSystemEvent fallback (double-announce bug).
      deliveryAttempted = true;
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    if (
      hadDescendants &&
      synthesizedText.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      !isSilentReplyText(initialSynthesizedText, SILENT_REPLY_TOKEN)
    ) {
      // Descendants existed but no post-orchestration synthesis arrived AND
      // no descendant fallback reply was available. Suppress stale parent
      // text like "on it, pulling everything together". Mark deliveryAttempted
      // so the timer does not fire a redundant enqueueSystemEvent fallback.
      deliveryAttempted = true;
      return params.withRunSession({
        status: "ok",
        summary,
        outputText,
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    const normalizedSynthesizedText = normalizeSilentReplyText(synthesizedText);
    if (
      normalizedSynthesizedText.text === undefined ||
      normalizedSynthesizedText.strippedTrailingSilentToken
    ) {
      return await finishSilentReplyDelivery();
    }
    synthesizedText = normalizedSynthesizedText.text;
    outputText = synthesizedText;
    if (params.isAborted()) {
      return params.withRunSession({
        status: "error",
        error: params.abortReason(),
        deliveryAttempted,
        ...params.telemetry,
      });
    }
    return await deliverViaDirectAndCleanup(delivery, { retryTransient: true });
  };

  if (params.deliveryRequested && !params.skipHeartbeatDelivery && !skipMessagingToolDelivery) {
    if (!params.resolvedDelivery.ok) {
      if (!params.deliveryBestEffort) {
        return {
          result: failDeliveryTarget(params.resolvedDelivery.error.message),
          delivered,
          deliveryAttempted,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
      await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return {
        result: params.withRunSession({
          status: "ok",
          summary,
          outputText,
          deliveryAttempted,
          ...params.telemetry,
        }),
        delivered,
        deliveryAttempted,
        summary,
        outputText,
        synthesizedText,
        deliveryPayloads,
      };
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // send through the real outbound adapter so delivered=true always reflects
    // an actual channel send instead of internal announce routing.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirectAndCleanup(params.resolvedDelivery);
      if (directResult) {
        return {
          result: directResult,
          delivered,
          deliveryAttempted,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
    } else {
      const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
      if (finalizedTextResult) {
        return {
          result: finalizedTextResult,
          delivered,
          deliveryAttempted,
          summary,
          outputText,
          synthesizedText,
          deliveryPayloads,
        };
      }
    }
  }

  return {
    delivered,
    deliveryAttempted,
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
  };
}
