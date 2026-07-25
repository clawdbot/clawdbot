/** Dispatches isolated cron output to direct delivery, mirrors, and follow-up queues. */
import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../../auto-reply/tokens.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import { resolveStorePath } from "../../config/sessions/inbound.runtime.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { isSuppressedControlReplyText } from "../../gateway/control-reply-text.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { isProvenDeliveryNotSentError } from "../../infra/delivery-recovery.shared.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  NormalizedOutboundPayload,
  OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryVisibleDelivery,
} from "../../infra/outbound/source-delivery-plan.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { retryAsync } from "../../infra/retry.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  isCronSessionKey,
  parseThreadSessionSuffix,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import { createCronExecutionId } from "../run-id.js";
import { hasScheduledNextRunAtMs } from "../service/jobs.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickLastNonEmptyTextFromPayloads, pickSummaryFromOutput } from "./helpers.js";
import { resolveCronLifecycleRevisionIdentity } from "./run-session-state.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import {
  cleanupCronRunSessionAfterRun,
  type CronRunSessionCleanupOutcome,
} from "./session-cleanup.js";
import { loadCronSessionEntryLatest } from "./session.js";
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
type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

type DispatchCronDeliveryParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeSessionDelete?: () => void;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  deliveryRequested: boolean;
  skipHeartbeatDelivery: boolean;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  ttsAuto?: TtsAutoMode;
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

type DirectCronTranscriptMirror = {
  sessionKey: string;
  agentId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  text?: string;
  mediaUrls?: string[];
  storePath?: string;
  idempotencyKey: string;
  config: OpenClawConfig;
};

/** Mutable delivery-dispatch accumulator returned to the isolated cron runner. */
type DispatchCronDeliveryState = {
  result?: RunCronAgentTurnResult;
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryError?: string;
  cronRunSessionCleanupAttempted: boolean;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
};

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

const deliveryOutboundRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-outbound.runtime.js"),
);
const outboundSessionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/outbound-session.js"),
);
const transcriptRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/transcript.runtime.js"),
);
const deliverySubagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-subagent-registry.runtime.js"),
);
const deliveryLoggerRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-logger.runtime.js"),
);
const subagentFollowupRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-followup.runtime.js"),
);
const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));

const COMPLETED_DIRECT_CRON_DELIVERIES = new Map<string, CompletedDirectCronDelivery>();

async function loadDeliveryOutboundRuntime(): Promise<
  typeof import("./delivery-outbound.runtime.js")
> {
  return await deliveryOutboundRuntimeLoader.load();
}

async function loadOutboundSessionRuntime(): Promise<
  typeof import("../../infra/outbound/outbound-session.js")
> {
  return await outboundSessionRuntimeLoader.load();
}

async function loadTranscriptRuntime(): Promise<
  typeof import("../../config/sessions/transcript.runtime.js")
> {
  return await transcriptRuntimeLoader.load();
}

async function loadDeliverySubagentRegistryRuntime(): Promise<
  typeof import("./delivery-subagent-registry.runtime.js")
> {
  return await deliverySubagentRegistryRuntimeLoader.load();
}

async function loadDeliveryLoggerRuntime(): Promise<typeof import("./delivery-logger.runtime.js")> {
  return await deliveryLoggerRuntimeLoader.load();
}

async function loadSubagentFollowupRuntime(): Promise<
  typeof import("./subagent-followup.runtime.js")
> {
  return await subagentFollowupRuntimeLoader.load();
}

async function loadTtsRuntime(): Promise<typeof import("../../tts/tts.runtime.js")> {
  return await ttsRuntimeLoader.load();
}

async function logCronDeliveryWarn(message: string): Promise<void> {
  const { logWarn } = await loadDeliveryLoggerRuntime();
  logWarn(message);
}

async function logCronDeliveryError(message: string): Promise<void> {
  const { logError } = await loadDeliveryLoggerRuntime();
  logError(message);
}

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
  // Cache completed sends by idempotency key so retry paths can report the
  // original delivery result instead of double-announcing a cron run.
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

async function maybeApplyTtsToCronPayloads(params: {
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

function buildDirectCronDeliveryIdempotencyKey(params: {
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

function shouldQueueCronAwareness(params: {
  job: CronJob;
  delivery: SuccessfulDeliveryTarget;
  deliveryBestEffort: boolean;
}): boolean {
  // Keep issue #52136 scoped to isolated runs with an explicit delivery target.
  // Default isolated announce delivery must not mirror text into the main session.
  return (
    params.job.sessionTarget === "isolated" &&
    !params.deliveryBestEffort &&
    params.delivery.mode === "explicit"
  );
}

function resolveCronAwarenessMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return params.cfg.session?.scope === "global"
    ? resolveMainSessionKey(params.cfg)
    : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
}

function isSameSessionKey(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return normalizedLeft != null && normalizedLeft === normalizedRight;
}

function resolveCronAwarenessText(params: {
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads?: ReplyPayload[];
  outboundPayloads?: NormalizedOutboundPayload[];
}): string | undefined {
  if (params.outboundPayloads?.length) {
    const projection = projectDeliveredDirectCronPayloadsForMirror(params.outboundPayloads);
    const projectedText = resolveDirectCronTranscriptMirrorText(projection);
    if (projectedText) {
      return projectedText;
    }
  }
  return params.deliveryPayloads
    ? pickLastNonEmptyTextFromPayloads(params.deliveryPayloads)
    : (normalizeOptionalString(params.outputText) ??
        normalizeOptionalString(params.synthesizedText));
}

function resolveDirectCronSummaryFallbackText(params: {
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
}): string | undefined {
  return (
    normalizeOptionalString(params.outputText) ??
    normalizeOptionalString(params.summary) ??
    normalizeOptionalString(params.synthesizedText)
  );
}

function shouldAttachDirectCronFallbackText(payload: ReplyPayload): boolean {
  return (
    Boolean(payload.channelData) &&
    !hasReplyPayloadContent(payload, { trimText: true, hasChannelData: false })
  );
}

function resolveDirectCronFallbackSourceIndex(
  payloads: ReplyPayload[],
  fallbackText: string | undefined,
): number | undefined {
  if (!fallbackText) {
    return undefined;
  }
  const index = payloads.findLastIndex(
    (payload) => normalizeOptionalString(payload.text) === fallbackText,
  );
  return index >= 0 ? index : undefined;
}

function formatTargetCronDeliveryAwarenessText(text: string): string {
  return `A scheduled cron job delivered this message to this channel:\n${text}`;
}

function formatTargetCronDeliveryFailureAwarenessText(params: {
  job: CronJob;
  channel: string;
  to: string;
  threadId?: string;
  error: unknown;
  partialDelivered?: boolean;
}): string {
  const targetParts = [`${params.channel}:${params.to}`];
  if (params.threadId) {
    targetParts.push(`thread ${params.threadId}`);
  }
  return [
    "A scheduled cron job attempted to deliver to this channel, but delivery failed.",
    `Job: ${params.job.name || params.job.id}`,
    `Target: ${targetParts.join(" ")}`,
    `Delivery error: ${formatErrorMessage(params.error)}`,
    params.partialDelivered
      ? "One or more scheduled message payloads may already have been delivered."
      : "No scheduled message was delivered.",
  ].join("\n");
}

async function queueCronAwarenessSystemEvent(params: {
  cfg: OpenClawConfig;
  jobId: string;
  agentId: string;
  deliveryIdempotencyKey: string;
  queueMainSession: boolean;
  targetSessionKey?: string;
  text: string;
  targetText?: string;
}): Promise<void> {
  try {
    const { enqueueSystemEvent } = await loadDeliveryOutboundRuntime();
    const mainSessionKey = resolveCronAwarenessMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
    if (params.queueMainSession) {
      enqueueSystemEvent(params.text, {
        sessionKey: mainSessionKey,
        contextKey: params.deliveryIdempotencyKey,
      });
    }
    const targetSessionKey = params.targetSessionKey;
    const shouldQueueTargetSession =
      targetSessionKey &&
      (!isSameSessionKey(targetSessionKey, mainSessionKey) || !params.queueMainSession);
    if (shouldQueueTargetSession) {
      enqueueSystemEvent(params.targetText ?? formatTargetCronDeliveryAwarenessText(params.text), {
        sessionKey: targetSessionKey,
        contextKey: params.deliveryIdempotencyKey,
      });
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.jobId}] failed to queue isolated cron awareness: ${formatErrorMessage(err)}`,
    );
  }
}

function isCustomCronSessionTarget(sessionTarget: CronJob["sessionTarget"]): boolean {
  return typeof sessionTarget === "string" && sessionTarget.startsWith("session:");
}

function buildDirectCronTranscriptMirrorPayloads(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return payloads.map((payload) => {
    const spokenText = normalizeOptionalString(payload.spokenText);
    if (!spokenText) {
      return payload;
    }
    // For TTS auto payloads the spoken text is the transcript content; keep
    // non-audio media only so mirrors do not show generated voice files twice.
    const mediaUrls = [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
      (url): url is string => Boolean(url) && !isAudioFileName(url),
    );
    const {
      mediaUrl: _mediaUrl,
      mediaUrls: _mediaUrls,
      audioAsVoice: _audioAsVoice,
      spokenText: _spokenText,
      ...rest
    } = payload;
    return {
      ...rest,
      text: spokenText,
      ...(mediaUrls.length ? { mediaUrls } : {}),
    };
  });
}

function resolveDirectCronTranscriptMirrorText(params: {
  text?: string;
  mediaUrls: string[];
}): string | undefined {
  const text = normalizeOptionalString(params.text);
  const mediaText = resolveMirroredTranscriptText({ mediaUrls: params.mediaUrls }) ?? undefined;
  if (text && mediaText) {
    return `${text}\n${mediaText}`;
  }
  if (text || mediaText) {
    return text ?? mediaText;
  }
  return undefined;
}

function pickDirectCronMirrorPayloadText(payload: NormalizedOutboundPayload): string | undefined {
  return normalizeOptionalString(payload.hookContent) ?? normalizeOptionalString(payload.text);
}

function isTtsAudioMirrorOnly(params: {
  payload: NormalizedOutboundPayload;
  mediaUrl: string;
}): boolean {
  return (
    (params.payload.audioAsVoice === true || Boolean(params.payload.hookContent)) &&
    isAudioFileName(params.mediaUrl)
  );
}

function projectDeliveredDirectCronPayloadsForMirror(
  payloads: readonly NormalizedOutboundPayload[],
): { text?: string; mediaUrls: string[] } {
  const textParts: string[] = [];
  const mediaUrls: string[] = [];
  for (const payload of payloads) {
    const text = pickDirectCronMirrorPayloadText(payload);
    if (text) {
      textParts.push(text);
    }
    for (const mediaUrl of payload.mediaUrls) {
      if (isTtsAudioMirrorOnly({ payload, mediaUrl })) {
        continue;
      }
      mediaUrls.push(mediaUrl);
    }
  }
  return {
    text: textParts.join("\n"),
    mediaUrls,
  };
}

function canonicalizeDirectCronRouteSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  const sessionKey = params.sessionKey.trim();
  const canonical = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey,
  });
  if (canonical !== sessionKey) {
    return canonical;
  }
  const thread = parseThreadSessionSuffix(sessionKey);
  if (!thread.baseSessionKey || !thread.threadId) {
    return sessionKey;
  }
  const canonicalBase = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: thread.baseSessionKey,
  });
  if (canonicalBase === thread.baseSessionKey || canonicalBase === "global") {
    return sessionKey;
  }
  return `${canonicalBase}:thread:${thread.threadId}`;
}

// Resolves the session for a concrete visible delivery target and ensures the
// outbound session exists before cron awareness or transcript code references it.
async function resolveCronDeliveryRouteSessionKey(params: {
  cfg: OpenClawConfig;
  jobId: string;
  agentId: string;
  agentSessionKey: string;
  delivery: SuccessfulDeliveryTarget;
  warningContext: string;
}): Promise<string> {
  try {
    const { resolveOutboundSessionRoute, ensureOutboundSessionEntry } =
      await loadOutboundSessionRuntime();
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.delivery.channel,
      agentId: params.agentId,
      accountId: params.delivery.accountId,
      target: params.delivery.to,
      currentSessionKey: params.agentSessionKey,
      threadId: params.delivery.threadId,
    });
    const routeSessionKey = route?.sessionKey?.trim();
    if (!route || !routeSessionKey) {
      return params.agentSessionKey;
    }
    const canonicalRouteSessionKey = canonicalizeDirectCronRouteSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: routeSessionKey,
    });
    const canonicalRouteBaseSessionKey = canonicalizeDirectCronRouteSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: route.baseSessionKey,
    });
    const canonicalRoute =
      canonicalRouteSessionKey === route.sessionKey &&
      canonicalRouteBaseSessionKey === route.baseSessionKey
        ? route
        : {
            ...route,
            sessionKey: canonicalRouteSessionKey,
            baseSessionKey: canonicalRouteBaseSessionKey,
          };
    // Bootstrap metadata for a cron-originated first contact so the resolved
    // outbound session is visible to session history before transcript append.
    await ensureOutboundSessionEntry({
      cfg: params.cfg,
      channel: params.delivery.channel,
      accountId: params.delivery.accountId,
      route: canonicalRoute,
    });
    return canonicalRouteSessionKey;
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.jobId}] failed to resolve destination session for ${params.warningContext}: ${formatErrorMessage(err)}`,
    );
    return params.agentSessionKey;
  }
}

/** Resolves the transcript mirror session for direct cron delivery. */
async function resolveDirectCronDeliverySessionKey(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  delivery: SuccessfulDeliveryTarget;
}): Promise<string> {
  if (isCustomCronSessionTarget(params.job.sessionTarget)) {
    // Custom session targets are already caller-selected; do not remap them
    // through outbound routing or the explicit session identity would drift.
    return params.agentSessionKey;
  }

  return await resolveCronDeliveryRouteSessionKey({
    cfg: params.cfg,
    jobId: params.job.id,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    delivery: params.delivery,
    warningContext: "direct delivery mirror",
  });
}

function resolveCronMessageToolAwarenessTarget(params: {
  delivery: SourceDeliveryVisibleDelivery;
  resolvedDelivery: DeliveryTargetResolution;
}): (SuccessfulDeliveryTarget & { text: string }) | undefined {
  const { target } = params.delivery;
  const text =
    normalizeOptionalString(target.text) ??
    resolveMirroredTranscriptText({ mediaUrls: target.mediaUrls }) ??
    undefined;
  if (!text) {
    return undefined;
  }
  const targetChannel = normalizeOptionalString(target.provider);
  const channel =
    targetChannel && targetChannel !== "message"
      ? targetChannel
      : params.delivery.verifiedTarget && params.resolvedDelivery.ok
        ? params.resolvedDelivery.channel
        : undefined;
  const to =
    normalizeOptionalString(target.to) ??
    (params.delivery.verifiedTarget && params.resolvedDelivery.ok
      ? params.resolvedDelivery.to
      : undefined);
  if (!channel || !to) {
    return undefined;
  }
  const accountId =
    target.accountId ??
    (params.delivery.verifiedTarget && params.resolvedDelivery.ok
      ? params.resolvedDelivery.accountId
      : undefined);
  const threadId =
    target.threadId ??
    (params.delivery.verifiedTarget && target.threadImplicit === true && params.resolvedDelivery.ok
      ? params.resolvedDelivery.threadId
      : undefined);
  return {
    ok: true,
    channel: channel as SuccessfulDeliveryTarget["channel"],
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    mode: "explicit",
    text,
  };
}

/** Queues target-session context awareness for cron deliveries made via message tool. */
export async function queueCronMessageToolDeliveryAwareness(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runStartedAt: number;
  resolvedDelivery: DeliveryTargetResolution;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
}): Promise<void> {
  const seen = new Set<string>();
  for (const delivery of params.sourceDeliveryOutcome.visibleDeliveries) {
    const target = resolveCronMessageToolAwarenessTarget({
      delivery,
      resolvedDelivery: params.resolvedDelivery,
    });
    if (!target) {
      continue;
    }
    const dedupeKey = [
      target.channel,
      normalizeDeliveryTarget(target.channel, target.to),
      target.accountId ?? "",
      target.threadId ?? "",
      target.text,
    ].join("\0");
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const targetSessionKey = await resolveCronDeliveryRouteSessionKey({
      cfg: params.cfg,
      jobId: params.job.id,
      agentId: params.agentId,
      agentSessionKey: params.agentSessionKey,
      delivery: target,
      warningContext: "message-tool delivery awareness",
    });
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery: target,
    });
    await queueCronAwarenessSystemEvent({
      cfg: params.cfg,
      jobId: params.job.id,
      agentId: params.agentId,
      deliveryIdempotencyKey,
      queueMainSession: false,
      targetSessionKey,
      text: target.text,
    });
  }
}

async function appendDirectCronDeliveryTranscriptMirror(params: {
  job: CronJob;
  mirror: DirectCronTranscriptMirror;
}): Promise<void> {
  if (!params.mirror.text && !params.mirror.mediaUrls?.length) {
    return;
  }
  try {
    const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
    const result = await appendAssistantMessageToSessionTranscript(params.mirror);
    if (!result.ok) {
      await logCronDeliveryWarn(
        `[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${result.reason}`,
      );
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] failed to mirror direct delivery into session transcript: ${formatErrorMessage(err)}`,
    );
  }
}

async function appendAdmittedDirectCronDeliveryTranscriptMirror(params: {
  job: CronJob;
  mirror: DirectCronTranscriptMirror;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const storePath = params.mirror.storePath;
  const initial = storePath
    ? loadCronSessionEntryLatest(storePath, params.mirror.sessionKey)
    : undefined;
  const expectedSessionId = params.mirror.expectedSessionId ?? initial?.sessionId;
  const expectedLifecycleRevision =
    params.mirror.expectedLifecycleRevision ?? initial?.lifecycleRevision;
  if (!storePath || !expectedSessionId) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] skipped transcript mirror without an exact session identity`,
    );
    return;
  }
  const admittedMirror = {
    ...params.mirror,
    expectedSessionId,
    ...(expectedLifecycleRevision ? { expectedLifecycleRevision } : {}),
  };

  try {
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [
        params.mirror.sessionKey,
        expectedSessionId,
        expectedLifecycleRevision
          ? resolveCronLifecycleRevisionIdentity(expectedLifecycleRevision)
          : undefined,
      ],
      signal: params.abortSignal,
      assertAllowed: () => {
        const latest = loadCronSessionEntryLatest(storePath, params.mirror.sessionKey);
        if (
          latest?.sessionId !== expectedSessionId ||
          (expectedLifecycleRevision !== undefined &&
            latest.lifecycleRevision !== expectedLifecycleRevision)
        ) {
          throw new Error(
            `Session "${params.mirror.sessionKey}" changed before transcript mirror.`,
          );
        }
        const archivedError = resolveSessionWorkStartError(params.mirror.sessionKey, latest);
        if (archivedError) {
          throw new Error(archivedError);
        }
      },
    });
    try {
      await admission.run(() =>
        appendDirectCronDeliveryTranscriptMirror({
          job: params.job,
          mirror: admittedMirror,
        }),
      );
    } finally {
      admission.release();
    }
  } catch (err) {
    await logCronDeliveryWarn(
      `[cron:${params.job.id}] skipped transcript mirror: ${formatErrorMessage(err)}`,
    );
  }
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

async function retryTransientDirectCronDelivery<T>(params: {
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
/** Dispatches cron run output through verified message-tool or direct delivery paths. */
export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const sourceDeliverySatisfied = params.sourceDeliveryOutcome.satisfiesSourceDelivery;
  const verifiedMessageToolDelivery = params.sourceDeliveryOutcome.verifiedMessageToolDelivery;
  let summary = params.summary;
  let outputText = params.outputText;
  let synthesizedText = params.synthesizedText;
  let deliveryPayloads = params.deliveryPayloads;

  let delivered = verifiedMessageToolDelivery;
  let deliveryAttempted = verifiedMessageToolDelivery;
  let deliveryError: string | undefined;
  let directCronSessionCleanupAttempted = false;
  let deferredDeletingSessionMirror: DirectCronTranscriptMirror | undefined;
  const buildDeliveryState = (result?: RunCronAgentTurnResult): DispatchCronDeliveryState => ({
    ...(result ? { result } : {}),
    delivered,
    deliveryAttempted,
    ...(deliveryError ? { deliveryError } : {}),
    cronRunSessionCleanupAttempted: directCronSessionCleanupAttempted,
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
  });
  const formatDeliveryTargetError = (error: string) =>
    params.sourceDeliveryOutcome.unverifiedMessageToolDelivery
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
  const cleanupDirectCronSessionIfNeeded = async (): Promise<CronRunSessionCleanupOutcome> => {
    if (directCronSessionCleanupAttempted) {
      return "not-requested";
    }
    const cleanupOutcome = await cleanupCronRunSessionAfterRun({
      job: params.job,
      agentSessionKey: params.agentSessionKey,
      sessionId: params.sessionId,
      lifecycleRevision: params.lifecycleRevision,
      sessionUpdatedAt: params.sessionUpdatedAt,
      beforeDelete: params.beforeSessionDelete,
      reason: "cron-delete-after-run-fallback",
    });
    if (cleanupOutcome !== "not-requested") {
      directCronSessionCleanupAttempted = true;
    }
    const survivingMirror = deferredDeletingSessionMirror;
    deferredDeletingSessionMirror = undefined;
    if (cleanupOutcome !== "not-requested" && cleanupOutcome !== "deleted" && survivingMirror) {
      await appendAdmittedDirectCronDeliveryTranscriptMirror({
        job: params.job,
        mirror: survivingMirror,
        abortSignal: params.abortSignal,
      });
    }
    return cleanupOutcome;
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
      resolveAgentOutboundIdentity,
      sendDurableMessageBatch,
    } = await loadDeliveryOutboundRuntime();
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      jobId: params.job.id,
      runStartedAt: params.runStartedAt,
      delivery,
    });
    try {
      const summaryFallbackText = resolveDirectCronSummaryFallbackText({
        outputText,
        summary,
        synthesizedText,
      });
      const normalizedSummaryFallback = summaryFallbackText
        ? normalizeSilentReplyText(summaryFallbackText)
        : undefined;
      const normalizedSummaryFallbackText =
        normalizedSummaryFallback?.strippedTrailingSilentToken === true
          ? undefined
          : normalizedSummaryFallback?.text;
      const normalizeDirectPayload = (payload: ReplyPayload): ReplyPayload => {
        const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
        return normalized
          ? {
              ...payload,
              text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
            }
          : payload;
      };
      const normalizedDeliveryPayloads = deliveryPayloads
        .map(normalizeDirectPayload)
        .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
      const existingFallbackSourceIndex = resolveDirectCronFallbackSourceIndex(
        normalizedDeliveryPayloads,
        normalizedSummaryFallbackText,
      );
      const needsFallbackSource =
        Boolean(normalizedSummaryFallbackText) &&
        normalizedDeliveryPayloads.some(shouldAttachDirectCronFallbackText) &&
        existingFallbackSourceIndex === undefined;
      const fallbackSourceIndex = needsFallbackSource ? 0 : existingFallbackSourceIndex;
      const directPayloads = needsFallbackSource
        ? [{ text: normalizedSummaryFallbackText }, ...normalizedDeliveryPayloads]
        : normalizedDeliveryPayloads;
      let normalizedPayloads: ReplyPayload[] = [];
      for (const payload of directPayloads) {
        normalizedPayloads.push(
          shouldAttachDirectCronFallbackText(payload) && normalizedSummaryFallbackText
            ? {
                ...payload,
                fallbackText: {
                  text: normalizedSummaryFallbackText,
                  ...(fallbackSourceIndex !== undefined
                    ? { replacesPayloadIndex: fallbackSourceIndex }
                    : {}),
                },
              }
            : payload,
        );
      }
      if (normalizedPayloads.length === 0 && normalizedSummaryFallbackText) {
        normalizedPayloads = [{ text: normalizedSummaryFallbackText }];
      }
      if (normalizedPayloads.length === 0) {
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
      const payloadsForDelivery = (
        await maybeApplyTtsToCronPayloads({
          cfg: params.cfgWithAgentDefaults,
          payloads: normalizedPayloads,
          delivery,
          agentId: params.agentId,
          ttsAuto: params.ttsAuto,
        })
      ).filter((p) => hasReplyPayloadContent(p, { trimText: true }));
      if (payloadsForDelivery.length === 0) {
        return await finishSilentReplyDelivery();
      }
      deliveryAttempted = true;
      const cachedResults = getCompletedDirectCronDelivery(deliveryIdempotencyKey);
      if (cachedResults) {
        // Cached entries are only recorded after a successful non-empty delivery.
        delivered = true;
        return null;
      }
      const deliverySessionKey = await resolveDirectCronDeliverySessionKey({
        cfg: params.cfgWithAgentDefaults,
        job: params.job,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        delivery,
      });
      const deliverySession = buildOutboundSessionContext({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        sessionKey: deliverySessionKey,
      });
      const awarenessMainSessionKey = resolveCronAwarenessMainSessionKey({
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
      });
      const mirrorTargetsAwarenessMainSession = isSameSessionKey(
        deliverySessionKey,
        awarenessMainSessionKey,
      );
      const mirrorTargetsDeletingRunSession =
        params.job.deleteAfterRun === true &&
        isCronSessionKey(params.agentSessionKey) &&
        isSameSessionKey(deliverySessionKey, params.agentSessionKey);

      // Track bestEffort partial failures so we can log them and avoid
      // marking the job as delivered when payloads were silently dropped.
      let hadPartialFailure = false;
      let payloadMayHaveReachedRecipientBeforeFailure = false;
      // `onPayload` fires after send hooks render the outbound payload, but before
      // platform send. The mirror only consumes this array after full delivery succeeds.
      const attemptedPayloadsForMirror: NormalizedOutboundPayload[] = [];
      const onError = params.deliveryBestEffort
        ? (err: unknown, _payload: unknown) => {
            hadPartialFailure = true;
            deliveryError ??= formatErrorMessage(err);
            logCronDeliveryErrorDeferred(
              `[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
            );
          }
        : undefined;
      const runDelivery = async () => {
        attemptedPayloadsForMirror.length = 0;
        const send = await sendDurableMessageBatch({
          cfg: params.cfgWithAgentDefaults,
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
          payloads: payloadsForDelivery,
          session: deliverySession,
          identity,
          bestEffort: params.deliveryBestEffort,
          durability: params.deliveryBestEffort ? "best_effort" : "required",
          deps: createOutboundSendDeps(params.deps),
          signal: params.abortSignal,
          onError,
          onPayload: (payload) => {
            attemptedPayloadsForMirror.push(payload);
          },
          // Isolated cron direct delivery uses its own transient retry loop.
          // Keep all attempts out of the write-ahead delivery queue so a
          // late-successful first send cannot leave behind a failed queue
          // entry that replays on the next restart.
          // See: https://github.com/openclaw/openclaw/issues/40545
          skipQueue: true,
        });
        // No durable id is still ambiguous: the adapter was already invoked.
        payloadMayHaveReachedRecipientBeforeFailure ||=
          send.payloadOutcomes?.some(
            (outcome) =>
              outcome.status === "sent" ||
              (outcome.status === "failed" && outcome.sentBeforeError) ||
              (outcome.status === "suppressed" &&
                outcome.reason === "adapter_returned_no_identity"),
          ) ?? false;
        if (send.status === "failed") {
          throw send.error;
        }
        if (send.status === "partial_failed") {
          payloadMayHaveReachedRecipientBeforeFailure = true;
          if (!params.deliveryBestEffort) {
            throw send.error;
          }
          hadPartialFailure = true;
          deliveryError ??= formatErrorMessage(send.error);
        }
        return send.status === "sent" || send.status === "partial_failed" ? send.results : [];
      };
      let deliveryResults: OutboundDeliveryResult[];
      try {
        deliveryResults = options?.retryTransient
          ? await retryTransientDirectCronDelivery({
              jobId: params.job.id,
              signal: params.abortSignal,
              run: runDelivery,
              shouldRetryError: () => !payloadMayHaveReachedRecipientBeforeFailure,
            })
          : await runDelivery();
      } catch (err) {
        const failureAwarenessText = formatTargetCronDeliveryFailureAwarenessText({
          job: params.job,
          channel: delivery.channel,
          to: delivery.to,
          threadId: stringifyRouteThreadId(delivery.threadId),
          error: err,
          partialDelivered: payloadMayHaveReachedRecipientBeforeFailure,
        });
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey: `${deliveryIdempotencyKey}:failure`,
          queueMainSession: false,
          targetSessionKey: deliverySessionKey,
          text: failureAwarenessText,
          targetText: failureAwarenessText,
        });
        throw err;
      }
      // Only mark delivered when ALL payloads succeeded (no partial failure).
      delivered = deliveryResults.length > 0 && !hadPartialFailure;
      // Intentionally leave partial success uncached: replay may duplicate the
      // successful subset, but caching it here would permanently drop the
      // failed payloads by converting the replay into delivered=true.
      const deliveryAwarenessText = resolveCronAwarenessText({
        outputText,
        synthesizedText,
        deliveryPayloads: payloadsForDelivery,
        outboundPayloads: attemptedPayloadsForMirror,
      });
      const shouldQueueAwarenessForDelivery = shouldQueueCronAwareness({
        job: params.job,
        delivery,
        deliveryBestEffort: params.deliveryBestEffort,
      });
      // For explicit isolated deliveries that resolve to the main session, the
      // awareness queue is the intentional main-session record on the next turn;
      // adding an immediate assistant mirror would make the cron text appear twice.
      const awarenessText = shouldQueueAwarenessForDelivery ? deliveryAwarenessText : undefined;
      const deliveryWillReachAwarenessMainSession =
        mirrorTargetsAwarenessMainSession &&
        shouldQueueAwarenessForDelivery &&
        Boolean(awarenessText);
      // Implicit/default isolated delivery must not create main-session awareness.
      const mirrorWouldBypassIsolatedAwarenessPolicy =
        mirrorTargetsAwarenessMainSession &&
        params.job.sessionTarget === "isolated" &&
        delivery.mode !== "explicit";
      if (
        delivered &&
        !deliveryWillReachAwarenessMainSession &&
        !mirrorWouldBypassIsolatedAwarenessPolicy
      ) {
        const mirrorProjection =
          attemptedPayloadsForMirror.length > 0
            ? projectDeliveredDirectCronPayloadsForMirror(attemptedPayloadsForMirror)
            : projectOutboundPayloadPlanForMirror(
                createOutboundPayloadPlan(
                  buildDirectCronTranscriptMirrorPayloads(payloadsForDelivery),
                  {
                    cfg: params.cfgWithAgentDefaults,
                    sessionKey: deliverySessionKey,
                    surface: delivery.channel,
                  },
                ),
              );
        const mirrorText = resolveDirectCronTranscriptMirrorText(mirrorProjection);
        const transcriptMirror = {
          sessionKey: deliverySessionKey,
          agentId: params.agentId,
          ...(mirrorTargetsDeletingRunSession
            ? {
                expectedSessionId: params.sessionId,
                expectedLifecycleRevision: params.lifecycleRevision,
              }
            : {}),
          text: mirrorText,
          // Keep cron delivery mirrors text-first: non-audio attachment names
          // are folded into mirrorText so media does not replace delivered text.
          mediaUrls: undefined,
          storePath: resolveStorePath(params.cfgWithAgentDefaults.session?.store, {
            agentId: resolveAgentIdFromSessionKey(deliverySessionKey),
          }),
          idempotencyKey: deliveryIdempotencyKey,
          config: params.cfgWithAgentDefaults,
        };
        if (mirrorTargetsDeletingRunSession) {
          deferredDeletingSessionMirror = transcriptMirror;
        } else {
          await appendAdmittedDirectCronDeliveryTranscriptMirror({
            job: params.job,
            mirror: transcriptMirror,
            abortSignal: params.abortSignal,
          });
        }
      }
      if (
        delivered &&
        !params.deliveryBestEffort &&
        deliveryAwarenessText &&
        (shouldQueueAwarenessForDelivery ||
          !isSameSessionKey(deliverySessionKey, awarenessMainSessionKey))
      ) {
        await queueCronAwarenessSystemEvent({
          cfg: params.cfgWithAgentDefaults,
          jobId: params.job.id,
          agentId: params.agentId,
          deliveryIdempotencyKey,
          queueMainSession: shouldQueueAwarenessForDelivery,
          text: deliveryAwarenessText,
          targetSessionKey: deliverySessionKey,
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
      deliveryError = formatErrorMessage(err);
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
    if (!params.deliveryBestEffort && (activeSubagentRuns > 0 || expectedSubagentFollowup)) {
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
    if (!params.deliveryBestEffort && activeSubagentRuns > 0) {
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

  if (params.deliveryRequested && !params.skipHeartbeatDelivery && !sourceDeliverySatisfied) {
    if (!params.resolvedDelivery.ok) {
      // The target could not be resolved (e.g. a keyless implicit cron whose
      // inherited shared-bucket target was refused). We never send here, so a
      // deleteAfterRun cron must still retire its session/transcript before
      // returning — otherwise the one-shot session leaks. Safe no-op for
      // non-deleteAfterRun / non-cron sessions (see cleanupDirectCronSession).
      await cleanupDirectCronSessionIfNeeded();
      if (!params.deliveryBestEffort) {
        return buildDeliveryState(failDeliveryTarget(params.resolvedDelivery.error.message));
      }
      delivered = false;
      deliveryError = params.resolvedDelivery.error.message;
      await logCronDeliveryWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return buildDeliveryState(
        params.withRunSession({
          status: "ok",
          summary,
          outputText,
          delivered,
          deliveryError,
          deliveryAttempted,
          ...params.telemetry,
        }),
      );
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // send through the real outbound adapter so delivered=true always reflects
    // an actual channel send instead of internal announce routing.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirectAndCleanup(params.resolvedDelivery);
      if (directResult) {
        return buildDeliveryState(directResult);
      }
    } else {
      const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
      if (finalizedTextResult) {
        return buildDeliveryState(finalizedTextResult);
      }
    }
  }

  return buildDeliveryState();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
