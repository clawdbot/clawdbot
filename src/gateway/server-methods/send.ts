import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { extractToolPayload } from "../../infra/outbound/tool-payload.js";
import { normalizePollInput } from "../../polls.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMessageActionParams,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

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

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: OpenClawConfig;
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
  const cfg = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  }).config;
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
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

export const sendHandlers: GatewayRequestHandlers = {
  "message.action": async ({ params, respond, context }) => {
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
      agentId?: string;
      toolContext?: {
        currentChannelId?: string;
        currentChannelProvider?: string;
        currentThreadTs?: string;
        currentMessageId?: string | number;
      };
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `message.action:${idem}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const inflightMap = getInflightMap(context);
    const inflight = inflightMap.get(dedupeKey);
    if (inflight) {
      const result = await inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported channel: ${input}`,
      rejectWebchatAsInternalOnly: true,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin?.actions?.handleAction) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Channel ${channel} does not support action ${request.action}.`,
        ),
      );
      return;
    }

    const work = (async (): Promise<InflightResult> => {
      try {
        const handled = await dispatchChannelMessageAction({
          channel,
          action: request.action as never,
          cfg,
          params: request.params,
          accountId: normalizeOptionalString(request.accountId) ?? undefined,
          requesterSenderId: normalizeOptionalString(request.requesterSenderId) ?? undefined,
          senderIsOwner: request.senderIsOwner,
          sessionKey: normalizeOptionalString(request.sessionKey) ?? undefined,
          sessionId: normalizeOptionalString(request.sessionId) ?? undefined,
          agentId: normalizeOptionalString(request.agentId) ?? undefined,
          toolContext: request.toolContext,
          dryRun: false,
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
        cacheGatewayDedupeSuccess({ context, dedupeKey, payload });
        return {
          ok: true,
          payload,
          meta: { channel },
        };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({ context, dedupeKey, error });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } finally {
      inflightMap.delete(dedupeKey);
    }
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
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      threadId?: string;
      sessionKey?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `send:${idem}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const inflightMap = getInflightMap(context);
    const inflight = inflightMap.get(dedupeKey);
    if (inflight) {
      const result = await inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
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
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported channel: ${input}`,
      rejectWebchatAsInternalOnly: true,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const accountId = normalizeOptionalString(request.accountId);
    const threadId = normalizeOptionalString(request.threadId);
    const outboundChannel = channel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      );
      return;
    }

    const work = (async (): Promise<InflightResult> => {
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
        const mirrorPayloads = normalizeReplyPayloadsForDelivery([
          { text: message, mediaUrl, mediaUrls },
        ]);
        const mirrorText = mirrorPayloads
          .map((payload) => payload.text)
          .filter(Boolean)
          .join("\n");
        const mirrorMediaUrls = mirrorPayloads.flatMap(
          (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
        );
        const providedSessionKey = normalizeOptionalLowercaseString(request.sessionKey);
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
          threadId,
        });
        const outboundRoute = derivedRoute
          ? providedSessionKey
            ? {
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
        });
        const results = await deliverOutboundPayloads({
          cfg,
          channel: outboundChannel,
          to: deliveryTarget,
          accountId,
          payloads: [{ text: message, mediaUrl, mediaUrls }],
          session: outboundSession,
          gifPlayback: request.gifPlayback,
          threadId: threadId ?? null,
          deps: outboundDeps,
          gatewayClientScopes: client?.connect?.scopes ?? [],
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

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({ context, dedupeKey, payload });
        return {
          ok: true,
          payload,
          meta: { channel },
        };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({ context, dedupeKey, error });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } finally {
      inflightMap.delete(dedupeKey);
    }
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
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`poll:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const to = request.to.trim();
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    const outbound = plugin?.outbound;
    if (
      typeof request.durationSeconds === "number" &&
      outbound?.supportsPollDurationSeconds !== true
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `durationSeconds is not supported for ${channel} polls`,
        ),
      );
      return;
    }
    if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `isAnonymous is not supported for ${channel} polls`),
      );
      return;
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
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
        );
        return;
      }
      const resolvedTarget = resolveGatewayOutboundTarget({
        channel: channel,
        to,
        cfg,
        accountId,
      });
      if (!resolvedTarget.ok) {
        respond(false, undefined, resolvedTarget.error);
        return;
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
        dedupeKey: `poll:${idem}`,
        payload,
      });
      respond(true, payload, undefined, { channel });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      cacheGatewayDedupeFailure({
        context,
        dedupeKey: `poll:${idem}`,
        error,
      });
      respond(false, undefined, error, {
        channel,
        error: formatForLog(err),
      });
    }
  },
};
