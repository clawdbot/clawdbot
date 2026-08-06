// Send gateway methods route operator/tool messages and poll actions through
// channel plugins, outbound session state, durable delivery, and transcript mirrors.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateMessageActionParams,
  validatePollParams,
  validateSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { sendDurableMessageBatch } from "../../channels/message/runtime.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { resolveChannelThreadAddressing } from "../../channels/thread-addressing.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import {
  hydrateAttachmentParamsForAction,
  resolveAttachmentMediaPolicy,
} from "../../infra/outbound/message-action-params.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  mirrorDeliveredSourceReplyToTranscript,
  reconcileTerminalSourceReplyDelivery,
} from "../../infra/outbound/source-reply-mirror.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { normalizePollInput } from "../../polls.js";
import {
  normalizeAccountId,
  normalizeAgentId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  resolveMissingAgentHarnessSessionError,
} from "../../sessions/agent-harness-session-key.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveGatewayConversationReadOrigin } from "../conversation-read-origin.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGatewayInflightRequest as resolveIdempotentGatewayRequest,
  runGatewayInflightWork,
  type GatewayInflightResult as InflightResult,
} from "./inflight.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type MessageActionToolContext = Omit<ChannelThreadingToolContext, "currentChatType">;
type MessageOperationPrefix = "message.action" | "poll" | "send";

type MessageOperationRoute = {
  channel: string;
  accountId: string;
  requestScope: string;
};

type MessageOperationRouteBinding = {
  key: string;
  reservedRoute?: MessageOperationRoute;
};

type MessageOperationRouteBindingEntry = {
  requestScope: string;
  retainUntilSettled: boolean;
  ts: number;
};

// Send and poll callers can spell one canonical route four ways by omitting or
// supplying channel/account defaults. Preserve every alias for the full result budget.
const MESSAGE_OPERATION_ROUTE_BINDING_MAX = DEDUPE_MAX * 4;
const messageOperationRouteBindings = new WeakMap<
  GatewayRequestContext,
  Map<string, MessageOperationRouteBindingEntry>
>();
const messageOperationRouteBindingQueues = new WeakMap<GatewayRequestContext, KeyedAsyncQueue>();

function pruneMessageOperationRouteBindings(
  bindings: Map<string, MessageOperationRouteBindingEntry>,
  now: number,
): void {
  for (const [key, entry] of bindings) {
    if (!entry.retainUntilSettled && now - entry.ts > DEDUPE_TTL_MS) {
      bindings.delete(key);
    }
  }
  const excess = bindings.size - MESSAGE_OPERATION_ROUTE_BINDING_MAX;
  if (excess <= 0) {
    return;
  }
  const oldestSettledKeys = [...bindings.entries()]
    .filter(([, entry]) => !entry.retainUntilSettled)
    .toSorted(([, left], [, right]) => left.ts - right.ts)
    .slice(0, excess)
    .map(([key]) => key);
  for (const key of oldestSettledKeys) {
    bindings.delete(key);
  }
}

function getMessageOperationRouteBindings(
  context: GatewayRequestContext,
): Map<string, MessageOperationRouteBindingEntry> {
  let bindings = messageOperationRouteBindings.get(context);
  if (!bindings) {
    bindings = new Map();
    messageOperationRouteBindings.set(context, bindings);
  }
  pruneMessageOperationRouteBindings(bindings, Date.now());
  return bindings;
}

function getMessageOperationRouteBindingQueue(context: GatewayRequestContext): KeyedAsyncQueue {
  let queue = messageOperationRouteBindingQueues.get(context);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    messageOperationRouteBindingQueues.set(context, queue);
  }
  return queue;
}

async function acquireMessageOperationRouteBindingLock(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
}): Promise<() => void> {
  if (!params.binding) {
    return () => undefined;
  }

  let signalAcquired: (() => void) | undefined;
  let signalRelease: (() => void) | undefined;
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  // The lock covers mutable route selection through canonical in-flight registration.
  // Otherwise a later retry can bind newer defaults while the first request is resolving.
  void getMessageOperationRouteBindingQueue(params.context).enqueue(
    params.binding.key,
    async () => {
      signalAcquired?.();
      await held;
    },
  );
  await acquired;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    signalRelease?.();
  };
}

function resolveTrustedMessageActionToolContext(params: {
  client: Parameters<GatewayRequestHandlers["message.action"]>[0]["client"];
  request: {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
  };
}):
  | {
      ok: true;
      toolContext: InternalChannelThreadingToolContext | undefined;
      requesterAccountId: string | undefined;
      requesterSenderId: string | undefined;
      sessionId: string | undefined;
      sourceReplySessionKey: string | undefined;
      sourceReplyFinal: boolean | undefined;
      sourceReplyToolCallId: string | undefined;
    }
  | { ok: false; error: ReturnType<typeof errorShape> } {
  // Current-turn metadata can relax channel read policy. It must come from the
  // signed ingress-issued turn context, never from message.action request fields.
  const identity = params.client?.internal?.agentRuntimeIdentity;
  const messageActionContext = identity?.messageActionContext;
  if (!identity || !messageActionContext) {
    return {
      ok: true,
      toolContext: undefined,
      requesterAccountId: undefined,
      requesterSenderId: undefined,
      sessionId: undefined,
      sourceReplySessionKey: undefined,
      sourceReplyFinal: undefined,
      sourceReplyToolCallId: undefined,
    };
  }
  if (Date.now() >= messageActionContext.expiresAtMs) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "message.action agent runtime context has expired",
      ),
    };
  }
  const requestSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(params.request.sessionKey);
  const identitySessionKey = normalizeSessionKeyPreservingOpaquePeerIds(identity.sessionKey);
  const identityAgentId = normalizeAgentId(identity.agentId);
  const requestAgentId = normalizeOptionalString(params.request.agentId);
  const sessionAgentId = parseAgentSessionKey(requestSessionKey)?.agentId;
  const requestSessionId = normalizeOptionalString(params.request.sessionId);
  const sourceReplySessionKey =
    normalizeSessionKeyPreservingOpaquePeerIds(messageActionContext.sourceReplySessionKey) ||
    undefined;
  const sourceReplySessionAgentId = parseAgentSessionKey(sourceReplySessionKey)?.agentId;
  if (
    !requestSessionKey ||
    requestSessionKey !== identitySessionKey ||
    (requestAgentId && normalizeAgentId(requestAgentId) !== identityAgentId) ||
    (sessionAgentId && normalizeAgentId(sessionAgentId) !== identityAgentId) ||
    (messageActionContext.sessionId && requestSessionId !== messageActionContext.sessionId) ||
    (sourceReplySessionKey &&
      (!sourceReplySessionAgentId ||
        normalizeAgentId(sourceReplySessionAgentId) !== identityAgentId))
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "message.action agent runtime identity does not match the requested session",
      ),
    };
  }
  return {
    ok: true,
    toolContext: messageActionContext.toolContext,
    requesterAccountId: messageActionContext.requesterAccountId,
    requesterSenderId: messageActionContext.requesterSenderId,
    sessionId: messageActionContext.sessionId,
    sourceReplySessionKey,
    sourceReplyFinal: messageActionContext.sourceReplyFinal,
    sourceReplyToolCallId: messageActionContext.sourceReplyToolCallId,
  };
}

function resolveMessageOperationAuthorityScope(params: {
  prefix: MessageOperationPrefix;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
}): string {
  return params.prefix === "message.action"
    ? `:${params.conversationReadOrigin ?? "delegated"}`
    : "";
}

function resolveGatewayInflightRequest(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requestScope?: string;
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
  const authorityScope = resolveMessageOperationAuthorityScope(params);
  const requestScope = params.requestScope ? `:${params.requestScope}` : "";
  const dedupeKey = `${params.prefix}${authorityScope}${requestScope}:${idem}`;
  return resolveIdempotentGatewayRequest({
    context: params.context,
    dedupeKey,
    idempotencyKey: idem,
    respond: params.respond,
  });
}

function parseMessageOperationRoute(
  requestScope: string | undefined,
): MessageOperationRoute | undefined {
  if (!requestScope) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(requestScope);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return undefined;
    }
    const channel = normalizeMessageChannel(parsed[0]);
    const accountId = normalizeOptionalAccountId(parsed[1]);
    if (!channel || channel !== parsed[0] || !accountId || accountId !== parsed[1]) {
      return undefined;
    }
    return { channel, accountId, requestScope };
  } catch {
    return undefined;
  }
}

function resolveMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requestChannel: unknown;
  accountIds: readonly unknown[];
}): MessageOperationRouteBinding | undefined {
  const rawChannel = readStringValue(params.requestChannel);
  const channel = rawChannel ? normalizeMessageChannel(rawChannel) : undefined;
  if (rawChannel && !channel) {
    return undefined;
  }
  const providedAccountIds = params.accountIds.filter(
    (value) => value !== undefined && value !== null && (typeof value !== "string" || value.trim()),
  );
  const normalizedAccountIds = providedAccountIds.map((value) =>
    typeof value === "string" ? normalizeOptionalAccountId(value) : undefined,
  );
  if (normalizedAccountIds.some((accountId) => !accountId)) {
    return undefined;
  }
  const distinctAccountIds = [...new Set(normalizedAccountIds as string[])];
  if (distinctAccountIds.length > 1) {
    return undefined;
  }
  const accountId = distinctAccountIds[0];
  const authorityScope = resolveMessageOperationAuthorityScope(params);
  const explicitRouteScope = JSON.stringify([channel ?? null, accountId ?? null]);
  const key = `${params.prefix}${authorityScope}:route-binding:${explicitRouteScope}:${params.idempotencyKey}`;
  return {
    key,
    reservedRoute: parseMessageOperationRoute(
      getMessageOperationRouteBindings(params.context).get(key)?.requestScope,
    ),
  };
}

function bindMessageOperationRoute(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  requestScope: string;
}): boolean {
  if (!params.binding) {
    return true;
  }
  const bindings = getMessageOperationRouteBindings(params.context);
  const existing = bindings.get(params.binding.key);
  if (existing) {
    if (existing.requestScope !== params.requestScope) {
      return false;
    }
    bindings.set(params.binding.key, { ...existing, ts: Date.now() });
    return true;
  }
  // Bind the canonical route before dispatch so retries can replay without
  // consulting mutable defaults or plugin/account configuration.
  bindings.set(params.binding.key, {
    ts: Date.now(),
    requestScope: params.requestScope,
    retainUntilSettled: false,
  });
  pruneMessageOperationRouteBindings(bindings, Date.now());
  return true;
}

function refreshMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  requestScope: string;
}): void {
  if (!params.binding) {
    return;
  }
  const bindings = getMessageOperationRouteBindings(params.context);
  const existing = bindings.get(params.binding.key);
  if (existing?.requestScope === params.requestScope) {
    bindings.set(params.binding.key, {
      ...existing,
      ts: Date.now(),
      retainUntilSettled: false,
    });
    pruneMessageOperationRouteBindings(bindings, Date.now());
  }
}

function retainMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  requestScope: string;
}): void {
  if (!params.binding) {
    return;
  }
  const bindings = getMessageOperationRouteBindings(params.context);
  const existing = bindings.get(params.binding.key);
  if (existing?.requestScope === params.requestScope) {
    // Active provider work owns this alias even past TTL or capacity pressure;
    // settlement below restarts ordinary expiry.
    bindings.set(params.binding.key, {
      ...existing,
      retainUntilSettled: true,
    });
  }
}

function replayReservedMessageOperationRoute(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
}): Promise<void> | undefined {
  if (!params.binding?.reservedRoute) {
    return undefined;
  }
  const inflight = resolveGatewayInflightRequest({
    context: params.context,
    prefix: params.prefix,
    idempotencyKey: params.idempotencyKey,
    respond: params.respond,
    conversationReadOrigin: params.conversationReadOrigin,
    requestScope: params.binding.reservedRoute.requestScope,
  });
  if (inflight.kind === "ready") {
    return undefined;
  }
  return inflight.done;
}

function resolveMessageOperationAccountRoute(params: {
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  accountIds: readonly unknown[];
  conflictMessage: string;
}): { accountId: string | undefined; requestScope: string } {
  const accountIds = params.accountIds
    .map((accountId) =>
      validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: params.channel,
        accountId,
        plugin: params.plugin,
      }),
    )
    .filter((accountId): accountId is string => accountId !== undefined);
  const distinctAccountIds = [...new Set(accountIds)];
  if (distinctAccountIds.length > 1) {
    throw new Error(params.conflictMessage);
  }
  const accountId = distinctAccountIds[0];
  // Missing input remains host-derived authority; this value only canonicalizes
  // idempotency and is not forwarded as a caller-supplied explicit selection.
  const effectiveAccountId =
    accountId ??
    normalizeAccountId(resolveChannelDefaultAccountId({ plugin: params.plugin, cfg: params.cfg }));
  return {
    accountId,
    requestScope: JSON.stringify([params.channel, effectiveAccountId]),
  };
}

async function withMessageOperationRoute<
  T extends {
    cfg: OpenClawConfig;
    channel: string;
    plugin: ChannelPlugin;
  },
>(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requestChannel: unknown;
  bindingAccountIds: readonly unknown[];
  routeAccountIds: (binding: MessageOperationRouteBinding | undefined) => readonly unknown[];
  conflictMessage: string;
  resolveChannel: (requestChannel: unknown) => Promise<T | undefined>;
  work: (
    route: T & {
      accountId: string | undefined;
      idem: string;
      dedupeKey: string;
    },
  ) => Promise<InflightResult>;
}): Promise<void> {
  const bindingParams = {
    context: params.context,
    prefix: params.prefix,
    idempotencyKey: params.idempotencyKey,
    conversationReadOrigin: params.conversationReadOrigin,
    requestChannel: params.requestChannel,
    accountIds: params.bindingAccountIds,
  };
  let binding = resolveMessageOperationRouteBinding(bindingParams);
  const releaseLock = await acquireMessageOperationRouteBindingLock({
    context: params.context,
    binding,
  });
  try {
    // Re-resolve under the lock so route aliases bind against current state; replay
    // releases first because awaiting while locked would deadlock concurrent retries.
    binding = resolveMessageOperationRouteBinding(bindingParams);
    const reservedReplay = replayReservedMessageOperationRoute({
      context: params.context,
      binding,
      prefix: params.prefix,
      idempotencyKey: params.idempotencyKey,
      respond: params.respond,
      conversationReadOrigin: params.conversationReadOrigin,
    });
    if (reservedReplay) {
      releaseLock();
      await reservedReplay;
      return;
    }
    const resolved = await params.resolveChannel(
      binding?.reservedRoute?.channel ?? params.requestChannel,
    );
    if (!resolved) {
      return;
    }
    let accountRoute: ReturnType<typeof resolveMessageOperationAccountRoute>;
    try {
      accountRoute = resolveMessageOperationAccountRoute({
        ...resolved,
        accountIds: params.routeAccountIds(binding),
        conflictMessage: params.conflictMessage,
      });
    } catch (error) {
      respondGatewayInvalidRequest({ respond: params.respond, channel: resolved.channel, error });
      return;
    }
    if (
      !bindMessageOperationRoute({
        context: params.context,
        binding,
        requestScope: accountRoute.requestScope,
      })
    ) {
      respondGatewayInvalidRequest({
        respond: params.respond,
        channel: resolved.channel,
        error: "idempotency key is already bound to a different message route",
      });
      return;
    }
    const inflight = resolveGatewayInflightRequest({
      context: params.context,
      prefix: params.prefix,
      idempotencyKey: params.idempotencyKey,
      respond: params.respond,
      conversationReadOrigin: params.conversationReadOrigin,
      requestScope: accountRoute.requestScope,
    });
    if (inflight.kind === "handled") {
      releaseLock();
      await inflight.done;
      return;
    }
    retainMessageOperationRouteBinding({
      context: params.context,
      binding,
      requestScope: accountRoute.requestScope,
    });
    const work = params
      .work({
        ...resolved,
        accountId: accountRoute.accountId,
        idem: inflight.idem,
        dedupeKey: inflight.dedupeKey,
      })
      .finally(() => {
        refreshMessageOperationRouteBinding({
          context: params.context,
          binding,
          requestScope: accountRoute.requestScope,
        });
      });
    const inflightWork = runGatewayInflightWork({ ...inflight, work, respond: params.respond });
    releaseLock();
    await inflightWork;
  } finally {
    releaseLock();
  }
}

function respondGatewayInvalidRequest(params: {
  respond: RespondFn;
  channel: string;
  error: unknown;
}): void {
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(params.error)), {
    channel: params.channel,
    error: formatForLog(params.error),
  });
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
  const normalizedChannel = channelInput ? normalizeMessageChannel(channelInput) : undefined;
  if (params.rejectWebchatAsInternalOnly && normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
      ),
    };
  }
  if (channelInput && !normalizedChannel) {
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
  const optionalKeys = ["chatId", "channelId", "toJid", "conversationId", "pollId"] as const;
  for (const key of optionalKeys) {
    if (key in params.result) {
      payload[key] = params.result[key];
    }
  }
  return payload;
}

function createGatewayInflightResult(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  channel: string;
  result: Pick<InflightResult, "ok" | "payload" | "error">;
  meta?: Record<string, unknown>;
}): InflightResult {
  params.context.dedupe.set(params.dedupeKey, { ts: Date.now(), ...params.result });
  return {
    ...params.result,
    meta: { channel: params.channel, ...params.meta },
  };
}

function createGatewayInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
  channel: string;
}): InflightResult {
  return createGatewayInflightResult({ ...params, result: { ok: true, payload: params.payload } });
}

function createGatewayInflightUnavailableFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  channel: string;
  err: unknown;
}): InflightResult {
  const error = errorShape(ErrorCodes.UNAVAILABLE, String(params.err));
  return createGatewayInflightResult({
    ...params,
    result: { ok: false, error },
    meta: { error: formatForLog(params.err) },
  });
}

async function mirrorDeliveredSourceReplyToTranscriptBestEffort(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}) {
  try {
    const mirrored = await mirrorDeliveredSourceReplyToTranscript(params.mirror);
    if (!mirrored && params.mirror.sourceReplyFinal === true) {
      params.context.logGateway?.warn?.(
        "Terminal source reply receipt was not mirrored; restart recovery is fail-closed.",
        {
          channel: params.mirror.channel,
          sessionKey: params.mirror.sessionKey,
        },
      );
    }
  } catch (err) {
    params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
      error: formatForLog(err),
      channel: params.mirror.channel,
      sessionKey: params.mirror.sessionKey,
    });
  }
}

const sourceReplyTranscriptMirrorQueue = new KeyedAsyncQueue();

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
  // Queue per session so current-conversation source replies are visible before
  // a following turn can read the transcript.
  return sourceReplyTranscriptMirrorQueue.enqueue(queueKey, () =>
    mirrorDeliveredSourceReplyToTranscriptBestEffort(params),
  );
}

export const sendHandlers: GatewayRequestHandlers = {
  "message.action": async ({ params, respond, context, client }) => {
    const p = params;
    if (!assertValidParams(p, validateMessageActionParams, "message.action", respond)) {
      return;
    }
    const request = p as {
      channel: string;
      action: string;
      params: Record<string, unknown>;
      accountId?: string;
      requesterAccountId?: string;
      requesterSenderId?: string;
      senderIsOwner?: boolean;
      sessionKey?: string;
      sessionId?: string;
      inboundTurnKind?: "user_request" | "room_event";
      agentId?: string;
      toolContext?: MessageActionToolContext;
      conversationReadOrigin?: "direct-operator";
      idempotencyKey: string;
    };
    const trustedContext = resolveTrustedMessageActionToolContext({ client, request });
    if (!trustedContext.ok) {
      respond(false, undefined, trustedContext.error);
      return;
    }
    const conversationReadOrigin = resolveGatewayConversationReadOrigin({
      client,
      requestedOrigin: request.conversationReadOrigin,
    });
    await withMessageOperationRoute({
      context,
      prefix: "message.action",
      idempotencyKey: request.idempotencyKey,
      respond,
      conversationReadOrigin,
      requestChannel: request.channel,
      bindingAccountIds: [request.accountId, request.params.accountId],
      routeAccountIds: (binding) => [
        request.accountId,
        request.params.accountId,
        binding?.reservedRoute?.accountId,
      ],
      conflictMessage: "message.action accountId does not match params.accountId",
      resolveChannel: async (requestChannel) => {
        const resolved = await resolveRequestedChannel({
          requestChannel,
          unsupportedMessage: (input) => `unsupported channel: ${input}`,
          context,
          rejectWebchatAsInternalOnly: true,
        });
        if ("error" in resolved) {
          respond(false, undefined, resolved.error);
          return undefined;
        }
        const { cfg: selectedCfg, sourceCfg, channel } = resolved;
        const cfg = resolveMessageActionRuntimeConfig({ cfg: selectedCfg, sourceCfg });
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
          return undefined;
        }
        return { cfg, channel, plugin };
      },
      work: async ({ cfg, channel, accountId, dedupeKey }) => {
        try {
          const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;
          const agentId =
            normalizeOptionalString(request.agentId) ??
            (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
          if (accountId) {
            request.params.accountId = accountId;
          }
          const resolvedMediaAccess =
            request.action === "send"
              ? resolveAgentScopedOutboundMediaAccess({
                  cfg,
                  agentId,
                  sessionKey,
                  messageProvider: sessionKey ? undefined : channel,
                  accountId: sessionKey
                    ? (trustedContext.requesterAccountId ?? accountId)
                    : accountId,
                  requesterSenderId: trustedContext.requesterSenderId,
                })
              : undefined;
          // Gateway identities omit trusted sender aliases; expose roots/workspace
          // only so a host reader cannot bypass alias-based group read policy.
          const mediaAccess = resolvedMediaAccess
            ? {
                localRoots: resolvedMediaAccess.localRoots,
                ...(resolvedMediaAccess.workspaceDir
                  ? { workspaceDir: resolvedMediaAccess.workspaceDir }
                  : {}),
              }
            : undefined;
          if (request.action === "send") {
            await hydrateAttachmentParamsForAction({
              cfg,
              channel,
              accountId,
              args: request.params,
              action: "send",
              mediaPolicy: resolveAttachmentMediaPolicy({
                mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
              }),
            });
          }
          const sourceReplyMirror = {
            action: request.action,
            channel,
            actionParams: request.params,
            cfg,
            accountId,
            currentAccountId: trustedContext.requesterAccountId,
            sessionKey: trustedContext.sourceReplySessionKey ?? sessionKey,
            sessionId: trustedContext.sessionId,
            agentId,
            toolContext: trustedContext.toolContext,
            idempotencyKey: request.idempotencyKey,
            toolCallId: trustedContext.sourceReplyToolCallId,
            ...(trustedContext.sourceReplyFinal !== undefined
              ? { sourceReplyFinal: trustedContext.sourceReplyFinal }
              : {}),
          };
          const terminalDeliveryReceipt =
            trustedContext.sourceReplyFinal === true
              ? await beginTerminalSourceReplyDelivery(sourceReplyMirror)
              : undefined;
          const gatewayClientScopes = client?.connect?.scopes ?? [];
          const handled = await dispatchChannelMessageAction({
            channel,
            action: request.action as never,
            cfg,
            params: request.params,
            accountId,
            requesterAccountId: trustedContext.requesterAccountId,
            requesterSenderId: trustedContext.requesterSenderId,
            senderIsOwner: gatewayClientScopes.includes(ADMIN_SCOPE)
              ? request.senderIsOwner === true
              : false,
            conversationReadOrigin,
            sessionKey,
            sessionId: normalizeOptionalString(request.sessionId) ?? undefined,
            inboundEventKind: request.inboundTurnKind,
            agentId,
            ...(mediaAccess
              ? { mediaAccess, mediaLocalRoots: mediaAccess.localRoots }
              : { mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId) }),
            toolContext: trustedContext.toolContext,
            dryRun: false,
            gatewayClientScopes,
          });
          if (!handled) {
            await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
            const error = errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Message action ${request.action} not supported for channel ${channel}.`,
            );
            return createGatewayInflightResult({
              context,
              dedupeKey,
              channel,
              result: { ok: false, error },
            });
          }
          const payload = extractToolPayload(handled);
          try {
            await reconcileTerminalSourceReplyDelivery({
              deliveredPayload: payload,
              mirror: sourceReplyMirror,
              receipt: terminalDeliveryReceipt,
            });
          } catch (err) {
            // The pre-send intent remains durable. Return the provider result so
            // the model does not retry an external effect with an unknown outcome.
            context.logGateway?.warn?.("Terminal source reply receipt reconciliation failed.", {
              error: formatForLog(err),
              channel,
              sessionKey,
            });
          }
          await scheduleDeliveredSourceReplyTranscriptMirror({
            context,
            mirror: {
              ...sourceReplyMirror,
              deliveredPayload: payload,
            },
          });
          return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
        } catch (err) {
          return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
        }
      },
    });
  },
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!assertValidParams(p, validateSendParams, "send", respond)) {
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      buffer?: string;
      filename?: string;
      contentType?: string;
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
    const to = normalizeOptionalString(request.to) ?? "";
    const message = request.message?.trim() ? request.message : "";
    const mediaUrl = normalizeOptionalString(request.mediaUrl);
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    const buffer = readStringValue(request.buffer);
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0 && !buffer) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    const requestedAccountId = normalizeOptionalString(request.accountId);
    const replyToId = normalizeOptionalString(request.replyToId);
    const threadId = normalizeOptionalString(request.threadId);
    await withMessageOperationRoute({
      context,
      prefix: "send",
      idempotencyKey: request.idempotencyKey,
      respond,
      requestChannel: request.channel,
      bindingAccountIds: [request.accountId],
      routeAccountIds: (binding) => [requestedAccountId, binding?.reservedRoute?.accountId],
      conflictMessage: "send account selections do not match",
      resolveChannel: async (requestChannel) => {
        const resolved = await resolveInternalDeliveryChannel(requestChannel, context);
        if (resolved.kind !== "ready") {
          const result = resolved.result;
          respond(result.ok, result.payload, result.error, result.meta);
          return undefined;
        }
        const { cfg, channel } = resolved;
        const plugin = resolveOutboundChannelPlugin({ channel, cfg });
        if (!plugin) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
          );
          return undefined;
        }
        return { cfg, channel, plugin };
      },
      work: async ({ cfg, channel, accountId, idem, dedupeKey }) => {
        try {
          const resolvedTarget = resolveGatewayOutboundTarget({
            channel,
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
          const sendArgs: Record<string, unknown> = {
            mediaUrl,
            mediaUrls,
            buffer,
            filename: normalizeOptionalString(request.filename) ?? undefined,
            contentType: normalizeOptionalString(request.contentType) ?? undefined,
          };
          await hydrateAttachmentParamsForAction({
            cfg,
            channel,
            accountId,
            args: sendArgs,
            action: "send",
            mediaPolicy: resolveAttachmentMediaPolicy({
              mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, effectiveAgentId),
            }),
          });
          const hydratedMediaUrl = normalizeOptionalString(sendArgs.mediaUrl);
          const hydratedMediaUrls = Array.isArray(sendArgs.mediaUrls)
            ? sendArgs.mediaUrls
                .map((entry) => normalizeOptionalString(entry))
                .filter((entry): entry is string => Boolean(entry))
            : undefined;
          const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
          const outboundPayloads = [
            {
              text: message,
              mediaUrl: hydratedMediaUrl,
              mediaUrls: hydratedMediaUrls,
              ...(request.asVoice === true ? { audioAsVoice: true } : {}),
            },
          ];
          const outboundPayloadPlan = createOutboundPayloadPlan(outboundPayloads);
          const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPayloadPlan);
          const mirrorText = mirrorProjection.text;
          const mirrorMediaUrls = mirrorProjection.mediaUrls;
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
            resolveChannelThreadAddressing(channel) === "message" &&
            Boolean(providedSessionKey) &&
            Boolean(normalizeOptionalString(derivedRoute?.threadId)) &&
            normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) ===
              normalizeOptionalLowercaseString(providedSessionBaseKey) &&
            normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
          // Message-scoped threads can refine an existing base session only after target lookup.
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
          const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
          if (outboundSessionKey && isAgentHarnessSessionKey(outboundSessionKey)) {
            const { canonicalKey, entry } = loadSessionEntry(outboundSessionKey);
            const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
              canonicalKey,
              entry,
            );
            if (missingHarnessSessionError) {
              return {
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
                meta: { channel },
              };
            }
          }
          if (outboundRoute) {
            await ensureOutboundSessionEntry({
              cfg,
              channel,
              accountId,
              route: outboundRoute,
            });
          }
          const outboundSession = buildOutboundSessionContext({
            cfg,
            agentId: effectiveAgentId,
            sessionKey: outboundSessionKey,
            conversationType: outboundRoute?.chatType,
          });
          const send = await sendDurableMessageBatch({
            cfg,
            channel,
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
          const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
          return createGatewayInflightSuccess({
            context,
            dedupeKey,
            payload,
            channel,
          });
        } catch (err) {
          return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
        }
      },
    });
  },
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!assertValidParams(p, validatePollParams, "poll", respond)) {
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
    await withMessageOperationRoute({
      context,
      prefix: "poll",
      idempotencyKey: request.idempotencyKey,
      respond,
      requestChannel: request.channel,
      bindingAccountIds: [request.accountId],
      routeAccountIds: (binding) => [request.accountId, binding?.reservedRoute?.accountId],
      conflictMessage: "poll account selections do not match",
      resolveChannel: async (requestChannel) => {
        const resolved = await resolveRequestedChannel({
          requestChannel,
          unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
          context,
        });
        if ("error" in resolved) {
          respond(false, undefined, resolved.error);
          return undefined;
        }
        const { cfg, channel } = resolved;
        const plugin = resolveOutboundChannelPlugin({ channel, cfg });
        const outbound = plugin?.outbound;
        if (
          typeof request.durationSeconds === "number" &&
          outbound?.supportsPollDurationSeconds !== true
        ) {
          // Duration support is channel-specific; reject before normalizing to avoid silent truncation.
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `durationSeconds is not supported for ${channel} polls`,
            ),
          );
          return undefined;
        }
        if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `isAnonymous is not supported for ${channel} polls`,
            ),
          );
          return undefined;
        }
        if (!plugin || !outbound?.sendPoll) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
          );
          return undefined;
        }
        return { cfg, channel, plugin, outbound, sendPoll: outbound.sendPoll };
      },
      work: async ({ cfg, channel, accountId, idem, dedupeKey, outbound, sendPoll }) => {
        const poll = {
          question: request.question,
          options: request.options,
          maxSelections: request.maxSelections,
          durationSeconds: request.durationSeconds,
          durationHours: request.durationHours,
        };
        const threadId = normalizeOptionalString(request.threadId);
        try {
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
          const result = await sendPoll({
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
          return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
        } catch (err) {
          return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
        }
      },
    });
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
