import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMessageActionParams,
  validatePollParams,
  validateSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { sendDurableMessageBatch } from "../../channels/message/runtime.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { mirrorDeliveredSourceReplyToTranscript } from "../../infra/outbound/source-reply-mirror.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { extractToolPayload } from "../../infra/outbound/tool-payload.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { normalizePollInput } from "../../polls.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

type InflightResult = {
  ok: boolean;
  payload?: unknown;
  error?: ReturnType<typeof errorShape>;
  meta?: Record<string, unknown>;
};

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<InflightResult>>
>();

const getInflightMap = (context: GatewayRequestContext) => {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
};

function resolveGatewayInflightMap(params: { context: GatewayRequestContext; dedupeKey: string }):
  | {
      kind: "cached";
      cached: NonNullable<ReturnType<GatewayRequestContext["dedupe"]["get"]>>;
    }
  | {
      kind: "inflight";
      inflight: Promise<InflightResult>;
    }
  | {
      kind: "ready";
      inflightMap: Map<string, Promise<InflightResult>>;
    } {
  // Persistent dedupe wins before process-local in-flight joins for idempotent retries.
  const cached = params.context.dedupe.get(params.dedupeKey);
  if (cached) {
    return { kind: "cached", cached };
  }
  const inflightMap = getInflightMap(params.context);
  const inflight = inflightMap.get(params.dedupeKey);
  if (inflight) {
    return { kind: "inflight", inflight };
  }
  return { kind: "ready", inflightMap };
}

function resolveGatewayInflightRequest(params: {
  context: GatewayRequestContext;
  prefix: "message.action" | "poll" | "send";
  idempotencyKey: string;
  respond: RespondFn;
}):
  | {
      kind: "ready";
      idem: string;
      dedupeKey: string;
      inflightMap: Map<string, Promise<InflightResult>>;
    }
  | {
      kind: "handled";
      done: Promise<void>;
    } {
  const idem = params.idempotencyKey;
  const dedupeKey = `${params.prefix}:${idem}`;
  const inflight = resolveGatewayInflightMap({
    context: params.context,
    dedupeKey,
  });
  if (inflight.kind === "cached") {
    params.respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, {
      cached: true,
    });
    return { kind: "handled", done: Promise.resolve() };
  }
  if (inflight.kind === "inflight") {
    return {
      kind: "handled",
      done: inflight.inflight.then((result) => {
        const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
        params.respond(result.ok, result.payload, result.error, meta);
      }),
    };
  }
  return {
    kind: "ready",
    idem,
    dedupeKey,
    inflightMap: inflight.inflightMap,
  };
}

async function runGatewayInflightWork(params: {
  inflightMap: Map<string, Promise<InflightResult>>;
  dedupeKey: string;
  work: Promise<InflightResult>;
  respond: RespondFn;
}) {
  params.inflightMap.set(params.dedupeKey, params.work);
  try {
    const result = await params.work;
    params.respond(result.ok, result.payload, result.error, result.meta);
  } finally {
    params.inflightMap.delete(params.dedupeKey);
  }
}

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: OpenClawConfig;
      sourceCfg: OpenClawConfig;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    const normalizedInput = normalizeOptionalLowercaseString(channelInput) ?? "";
    if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
        ),
      };
    }
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const sourceCfg = params.context.getRuntimeConfig();
  const cfg = resolveGatewayPluginConfig({
    config: sourceCfg,
  });
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, sourceCfg, channel };
}

async function resolveInternalDeliveryChannel(
  requestChannel: unknown,
  context: GatewayRequestContext,
): Promise<
  | {
      kind: "ready";
      cfg: OpenClawConfig;
      sourceCfg: OpenClawConfig;
      channel: string;
    }
  | {
      kind: "failed";
      result: InflightResult;
    }
> {
  const resolvedChannel = await resolveRequestedChannel({
    requestChannel,
    unsupportedMessage: (input) => `unsupported channel: ${input}`,
    context,
    rejectWebchatAsInternalOnly: true,
  });
  if ("error" in resolvedChannel) {
    return {
      kind: "failed",
      result: { ok: false, error: resolvedChannel.error },
    };
  }
  return { kind: "ready", ...resolvedChannel };
}

function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: OpenClawConfig;
  accountId?: string;
}):
  | {
      ok: true;
      to: string;
    }
  | {
      ok: false;
      error: ReturnType<typeof errorShape>;
    } {
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true, to: resolved.to };
}

function resolveMessageActionRuntimeConfig(params: {
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
}): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return params.cfg;
  }
  const selected = selectApplicableRuntimeConfig({
    inputConfig: params.sourceCfg,
    runtimeConfig,
    runtimeSourceConfig,
  });
  // Message actions must use the hot runtime snapshot when it matches the caller's source config.
  if (selected === runtimeConfig && selected !== params.cfg) {
    return resolveGatewayPluginConfig({ config: selected });
  }
  return params.cfg;
}

function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    messageId: params.result.messageId,
    channel: params.channel,
  };
  if ("chatId" in params.result) {
    payload.chatId = params.result.chatId;
  }
  if ("channelId" in params.result) {
    payload.channelId = params.result.channelId;
  }
  if ("toJid" in params.result) {
    payload.toJid = params.result.toJid;
  }
  if ("conversationId" in params.result) {
    payload.conversationId = params.result.conversationId;
  }
  if ("pollId" in params.result) {
    payload.pollId = params.result.pollId;
  }
  return payload;
}

function cacheGatewayDedupeSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: true,
    payload: params.payload,
  });
}

function cacheGatewayDedupeFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  error: ReturnType<typeof errorShape>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: false,
    error: params.error,
  });
}

function createGatewayInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
  channel: string;
}): InflightResult {
  cacheGatewayDedupeSuccess({
    context: params.context,
    dedupeKey: params.dedupeKey,
    payload: params.payload,
  });
  return {
    ok: true,
    payload: params.payload,
    meta: { channel: params.channel },
  };
}

function createGatewayDeliveryInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): InflightResult {
  return createGatewayInflightSuccess({
    context: params.context,
    dedupeKey: params.dedupeKey,
    payload: buildGatewayDeliveryPayload({
      runId: params.runId,
      channel: params.channel,
      result: params.result,
    }),
    channel: params.channel,
  });
}

function createGatewayInflightUnavailableFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  channel: string;
  err: unknown;
}): InflightResult {
  const error = errorShape(ErrorCodes.UNAVAILABLE, String(params.err));
  cacheGatewayDedupeFailure({
    context: params.context,
    dedupeKey: params.dedupeKey,
    error,
  });
  return {
    ok: false,
    error,
    meta: { channel: params.channel, error: formatForLog(params.err) },
  };
}

async function mirrorDeliveredSourceReplyToTranscriptBestEffort(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}) {
  try {
    await mirrorDeliveredSourceReplyToTranscript(params.mirror);
  } catch (err) {
    params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
      error: formatForLog(err),
      channel: params.mirror.channel,
      sessionKey: params.mirror.sessionKey,
    });
  }
}

const sourceReplyTranscriptMirrorQueues = new Map<string, Promise<void>>();

function resolveSourceReplyTranscriptMirrorQueueKey(
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0],
): string {
  // Missing session keys are serialized together so global mirrors preserve delivery order.
  return mirror.sessionKey?.trim() || "__global__";
}

function scheduleDeliveredSourceReplyTranscriptMirror(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}): Promise<void> {
  const queueKey = resolveSourceReplyTranscriptMirrorQueueKey(params.mirror);
  const previous = sourceReplyTranscriptMirrorQueues.get(queueKey);
  // Queue per session so current-conversation source replies are visible before
  // a following turn can read the transcript.
  const queued = (async () => {
    await previous?.catch(() => undefined);
    await mirrorDeliveredSourceReplyToTranscriptBestEffort(params);
  })();
  sourceReplyTranscriptMirrorQueues.set(queueKey, queued);
  void queued
    .finally(() => {
      if (sourceReplyTranscriptMirrorQueues.get(queueKey) === queued) {
        sourceReplyTranscriptMirrorQueues.delete(queueKey);
      }
    })
    .catch(() => undefined);
  return queued;
}

export const sendHandlers: GatewayRequestHandlers = {
  "message.action": async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateMessageActionParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid message.action params: ${formatValidationErrors(validateMessageActionParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      channel: string;
      action: string;
      params: Record<string, unknown>;
      accountId?: string;
      requesterSenderId?: string;
      senderIsOwner?: boolean;
      sessionKey?: string;
      sessionId?: string;
      inboundTurnKind?: "user_request" | "room_event";
      agentId?: string;
      toolContext?: {
        currentChannelId?: string;
        currentChannelProvider?: string;
        currentThreadTs?: string;
        currentMessageId?: string | number;
      };
      idempotencyKey: string;
    };
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "message.action",
      idempotencyKey: request.idempotencyKey,
      respond,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { dedupeKey, inflightMap } = inflight;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        context,
        rejectWebchatAsInternalOnly: true,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg: selectedCfg, sourceCfg, channel } = resolvedChannel;
      const cfg = resolveMessageActionRuntimeConfig({ cfg: selectedCfg, sourceCfg });
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin?.actions?.handleAction) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Channel ${channel} does not support action ${request.action}.`,
          ),
        };
      }

      try {
        const gatewayClientScopes = client?.connect?.scopes ?? [];
        const handled = await dispatchChannelMessageAction({
          channel,
          action: request.action as never,
          cfg,
          params: request.params,
          accountId: normalizeOptionalString(request.accountId) ?? undefined,
          requesterSenderId: normalizeOptionalString(request.requesterSenderId) ?? undefined,
          senderIsOwner: gatewayClientScopes.includes(ADMIN_SCOPE)
            ? request.senderIsOwner === true
            : false,
          sessionKey: normalizeOptionalString(request.sessionKey) ?? undefined,
          sessionId: normalizeOptionalString(request.sessionId) ?? undefined,
          inboundEventKind: request.inboundTurnKind,
          agentId: normalizeOptionalString(request.agentId) ?? undefined,
          mediaLocalRoots: getAgentScopedMediaLocalRoots(
            cfg,
            normalizeOptionalString(request.agentId) ?? undefined,
          ),
          toolContext: request.toolContext,
          dryRun: false,
          gatewayClientScopes,
        });
        if (!handled) {
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Message action ${request.action} not supported for channel ${channel}.`,
          );
          cacheGatewayDedupeFailure({ context, dedupeKey, error });
          return { ok: false, error, meta: { channel } };
        }
        const payload = extractToolPayload(handled);
        const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;
        const agentId =
          normalizeOptionalString(request.agentId) ??
          (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
        await scheduleDeliveredSourceReplyTranscriptMirror({
          context,
          mirror: {
            action: request.action,
            channel,
            actionParams: request.params,
            cfg,
            sessionKey,
            agentId,
            toolContext: request.toolContext,
            idempotencyKey: request.idempotencyKey,
            deliveredPayload: payload,
          },
        });
        return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
      } catch (err) {
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      asVoice?: boolean;
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      replyToId?: string;
      threadId?: string;
      forceDocument?: boolean;
      silent?: boolean;
      parseMode?: "HTML";
      sessionKey?: string;
      idempotencyKey: string;
    };
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "send",
      idempotencyKey: request.idempotencyKey,
      respond,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { idem, dedupeKey, inflightMap } = inflight;
    const to = normalizeOptionalString(request.to) ?? "";
    const message = normalizeOptionalString(request.message) ?? "";
    const mediaUrl = normalizeOptionalString(request.mediaUrl);
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    const accountId = normalizeOptionalString(request.accountId);
    const replyToId = normalizeOptionalString(request.replyToId);
    const threadId = normalizeOptionalString(request.threadId);

    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveInternalDeliveryChannel(request.channel, context);
      if (resolvedChannel.kind !== "ready") {
        return resolvedChannel.result;
      }
      const { cfg, channel } = resolvedChannel;
      const outboundChannel = channel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
        };
      }

      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel: outboundChannel,
          to,
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return {
            ok: false,
            error: resolvedTarget.error,
            meta: { channel },
          };
        }
        const idLikeTarget = await maybeResolveIdLikeTarget({
          cfg,
          channel,
          input: resolvedTarget.to,
          accountId,
        });
        const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const outboundPayloads = [
          {
            text: message,
            mediaUrl,
            mediaUrls,
            ...(request.asVoice === true ? { audioAsVoice: true } : {}),
          },
        ];
        const outboundPayloadPlan = createOutboundPayloadPlan(outboundPayloads);
        const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPayloadPlan);
        const mirrorText = mirrorProjection.text;
        const mirrorMediaUrls = mirrorProjection.mediaUrls;
        // Preserve opaque, case-sensitive peer IDs (e.g. Matrix room ids) on an
        // explicit session key instead of raw-lowercasing it (openclaw#75670).
        // Non-enrolled channels still canonicalize to lowercase via the registry.
        const providedSessionKey =
          normalizeSessionKeyPreservingOpaquePeerIds(request.sessionKey) || undefined;
        const explicitAgentId = normalizeOptionalString(request.agentId);
        const sessionAgentId = providedSessionKey
          ? resolveSessionAgentId({ sessionKey: providedSessionKey, config: cfg })
          : undefined;
        const defaultAgentId = resolveSessionAgentId({ config: cfg });
        const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
        const derivedRoute = await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId: effectiveAgentId,
          accountId,
          target: deliveryTarget,
          currentSessionKey: providedSessionKey,
          resolvedTarget: idLikeTarget,
          replyToId,
          threadId,
        });
        const providedSessionBaseKey =
          parseThreadSessionSuffix(providedSessionKey).baseSessionKey ?? providedSessionKey;
        const shouldUseDerivedThreadSessionKey =
          channel === "slack" &&
          Boolean(providedSessionKey) &&
          Boolean(normalizeOptionalString(derivedRoute?.threadId)) &&
          normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) ===
            normalizeOptionalLowercaseString(providedSessionBaseKey) &&
          normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
        // Slack replies can refine an existing base session into a thread session after target lookup.
        const outboundRoute = derivedRoute
          ? providedSessionKey
            ? shouldUseDerivedThreadSessionKey
              ? {
                  ...derivedRoute,
                  baseSessionKey: derivedRoute.baseSessionKey ?? providedSessionKey,
                }
              : {
                  ...derivedRoute,
                  sessionKey: providedSessionKey,
                  baseSessionKey: providedSessionKey,
                }
            : derivedRoute
          : null;
        if (outboundRoute) {
          await ensureOutboundSessionEntry({
            cfg,
            channel,
            accountId,
            route: outboundRoute,
          });
        }
        const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
        const outboundSession = buildOutboundSessionContext({
          cfg,
          agentId: effectiveAgentId,
          sessionKey: outboundSessionKey,
          conversationType: outboundRoute?.chatType,
        });
        const send = await sendDurableMessageBatch({
          cfg,
          channel: outboundChannel,
          to: deliveryTarget,
          accountId,
          payloads: outboundPayloads,
          replyToId: replyToId ?? null,
          session: outboundSession,
          gifPlayback: request.gifPlayback,
          forceDocument: request.forceDocument,
          threadId: outboundRoute?.threadId ?? threadId ?? null,
          deps: outboundDeps,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          silent: request.silent,
          formatting: request.parseMode ? { parseMode: request.parseMode } : undefined,
          mirror: outboundSessionKey
            ? {
                sessionKey: outboundSessionKey,
                agentId: effectiveAgentId,
                text: mirrorText || message,
                mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                idempotencyKey: idem,
              }
            : undefined,
        });
        if (send.status === "failed" || send.status === "partial_failed") {
          throw send.error;
        }
        const results = send.status === "sent" ? send.results : [];

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        return createGatewayDeliveryInflightSuccess({
          context,
          dedupeKey,
          runId: idem,
          channel,
          result,
        });
      } catch (err) {
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "poll",
      idempotencyKey: request.idempotencyKey,
      respond,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { idem, dedupeKey, inflightMap } = inflight;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
        context,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg, channel } = resolvedChannel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      if (
        typeof request.durationSeconds === "number" &&
        outbound?.supportsPollDurationSeconds !== true
      ) {
        // Duration support is channel-specific; reject before normalizing to avoid silent truncation.
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `durationSeconds is not supported for ${channel} polls`,
          ),
        };
      }
      if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `isAnonymous is not supported for ${channel} polls`,
          ),
        };
      }
      const poll = {
        question: request.question,
        options: request.options,
        maxSelections: request.maxSelections,
        durationSeconds: request.durationSeconds,
        durationHours: request.durationHours,
      };
      const threadId = normalizeOptionalString(request.threadId);
      const accountId = normalizeOptionalString(request.accountId);
      try {
        if (!outbound?.sendPoll) {
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported poll channel: ${channel}`,
          );
          return { ok: false, error };
        }
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel,
          to: request.to.trim(),
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        const result = await outbound.sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({
          context,
          dedupeKey,
          payload,
        });
        return { ok: true, payload, meta: { channel } };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({
          context,
          dedupeKey,
          error,
        });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
};
