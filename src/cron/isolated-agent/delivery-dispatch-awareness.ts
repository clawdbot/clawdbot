/** Session awareness and transcript mirroring for direct cron delivery. */
import { isAudioFileName } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../../config/sessions/main-session.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { NormalizedOutboundPayload } from "../../infra/outbound/deliver.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryVisibleDelivery,
} from "../../infra/outbound/source-delivery-plan.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { parseThreadSessionSuffix } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import {
  buildDirectCronDeliveryIdempotencyKey,
  logCronDeliveryWarn,
  normalizeDeliveryTarget,
} from "./delivery-dispatch-policy.js";
import { selectCronRouteCurrentSessionKey } from "./delivery-route-session-key.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickLastNonEmptyTextFromPayloads } from "./helpers.js";
import { resolveCronLifecycleRevisionIdentity } from "./run-session-state.js";
import { loadCronSessionEntryLatest } from "./session.js";

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

export type DirectCronTranscriptMirror = {
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

const deliveryOutboundRuntimeLoader = createLazyImportLoader(
  () => import("./delivery-outbound.runtime.js"),
);
const outboundSessionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/outbound-session.js"),
);
const transcriptRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/transcript.runtime.js"),
);
export function shouldQueueCronAwareness(params: {
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

export function resolveCronAwarenessMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return params.cfg.session?.scope === "global"
    ? resolveMainSessionKey(params.cfg)
    : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
}

export function isSameSessionKey(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return normalizedLeft != null && normalizedLeft === normalizedRight;
}

export function resolveCronAwarenessText(params: {
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

export function resolveDirectCronSummaryFallbackText(params: {
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

export function shouldAttachDirectCronFallbackText(payload: ReplyPayload): boolean {
  return (
    Boolean(payload.channelData) &&
    !hasReplyPayloadContent(payload, { trimText: true, hasChannelData: false })
  );
}

export function resolveDirectCronFallbackSourceIndex(
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
  return `A scheduled automation delivered this message to this channel:\n${text}`;
}

export function formatTargetCronDeliveryFailureAwarenessText(params: {
  job: CronJob;
  channel: string;
  to: string;
  threadId?: string;
  partialDelivered?: boolean;
}): string {
  const targetParts = [`${params.channel}:${params.to}`];
  if (params.threadId) {
    targetParts.push(`thread ${params.threadId}`);
  }
  return [
    "A scheduled automation attempted to deliver to this channel, but delivery failed.",
    `Job: ${params.job.name || params.job.id}`,
    `Target: ${targetParts.join(" ")}`,
    "Check automation history for delivery error details.",
    params.partialDelivered
      ? "One or more scheduled message payloads may already have been delivered."
      : "No scheduled message was delivered.",
  ].join("\n");
}

export async function queueCronAwarenessSystemEvent(params: {
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
    const { enqueueSystemEvent } = await deliveryOutboundRuntimeLoader.load();
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

export function buildDirectCronTranscriptMirrorPayloads(
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

export function resolveDirectCronTranscriptMirrorText(params: {
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

export function projectDeliveredDirectCronPayloadsForMirror(
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
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  delivery: SuccessfulDeliveryTarget;
  warningContext: string;
}): Promise<string> {
  try {
    const { resolveOutboundSessionRoute, ensureOutboundSessionEntry } =
      await outboundSessionRuntimeLoader.load();
    const route = await resolveOutboundSessionRoute({
      cfg: params.cfg,
      channel: params.delivery.channel,
      agentId: params.agentId,
      accountId: params.delivery.accountId,
      target: params.delivery.to,
      currentSessionKey: selectCronRouteCurrentSessionKey(
        params.job,
        params.agentSessionKey,
        params.delivery.channel,
        params.delivery.to,
      ),
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
      `[cron:${params.job.id}] failed to resolve destination session for ${params.warningContext}: ${formatErrorMessage(err)}`,
    );
    return params.agentSessionKey;
  }
}

/** Resolves the transcript mirror session for direct cron delivery. */
export async function resolveDirectCronDeliverySessionKey(params: {
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
    job: params.job,
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
      job: params.job,
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
    const { appendAssistantMessageToSessionTranscript } = await transcriptRuntimeLoader.load();
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

export async function appendAdmittedDirectCronDeliveryTranscriptMirror(params: {
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
