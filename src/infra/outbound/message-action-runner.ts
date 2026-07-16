// Message-action runner normalizes tool params, resolves channel/target/media,
// applies policies, and dispatches send/poll/plugin actions.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveAgentIdentity, resolveResponsePrefix } from "../../agents/identity.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import {
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { normalizeOutboundLocation } from "../../channels/location.js";
import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../../channels/plugins/conversation-read-origin.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
  hasReplyPayloadContent,
  normalizeInteractiveReply,
  normalizeMessagePresentation,
  type ReplyPayloadDelivery,
} from "../../interactive/payload.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { hasPollCreationParams } from "../../poll-params.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import type { OutboundSendDeps } from "./deliver.js";
import { shouldUseInternalSourceReplySink } from "./internal-source-reply.js";
import { normalizeMessageActionInput } from "./message-action-normalization.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";
import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  parseInteractiveParam,
  parseJsonMessageParam,
  readBooleanParam,
  resolveAttachmentMediaPolicy,
  resolveExtraActionMediaSourceParamKeys,
} from "./message-action-params.js";
import { actionRequiresTarget } from "./message-action-spec.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundReplyToId,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./message-action-tts.js";
import { resolveOutboundMessageGatewayOptions } from "./message-gateway-options.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  enforceCrossContextPolicy,
  enforceMessageActionAllowlist,
  resolveEffectiveMessageToolsConfig,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import {
  executePollAction,
  executeSendAction,
  hasCorePresentationDelivery,
  materializeMessagePresentationFallback,
} from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  resolveAgentRuntimeIdentityToken?: () => Promise<string | undefined>;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

// Gateway runtime is only needed for remote message action dispatch or
// idempotency keys; keep normal in-process actions import-light.
const loadMessageActionGatewayRuntime = createLazyRuntimeModule(
  () => import("./message.gateway.runtime.js"),
);

export type RunMessageActionParams = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  /**
   * Authorization facts resolved from the host-issued current-turn capability.
   * Presence means ambient routing fields must not be used as identity.
   */
  messageActionAuthorization?: {
    requesterAccountId?: string;
    requesterSenderId?: string;
    toolContext?: ChannelThreadingToolContext;
  };
  sessionId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  sandboxRoot?: string;
  dryRun?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  inboundEventKind?: InboundEventKind;
  inboundAudio?: boolean;
  abortSignal?: AbortSignal;
};

export type MessageActionRunResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core" | "internal-source";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          sentBeforeError?: true;
          payload?: unknown;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    };

export function getToolResult(
  result: MessageActionRunResult,
): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function resolveGatewayActionOptions(gateway?: MessageActionRunnerGateway) {
  return resolveOutboundMessageGatewayOptions(gateway);
}

const MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS = 60_000;
const MESSAGE_ACTION_RECONCILIATION_MAX_MS = 9 * 60_000;
const MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS = 30_000;

async function callGatewayMessageAction<T>(params: {
  gateway?: MessageActionRunnerGateway;
  actionParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const { callGatewayLeastPrivilege, isGatewayTransportError } =
    await loadMessageActionGatewayRuntime();
  const gateway = resolveGatewayActionOptions(params.gateway);
  const agentRuntimeIdentityToken = await params.gateway?.resolveAgentRuntimeIdentityToken?.();
  // A timed-out send is reattached with the same idempotency key. Cap only the
  // initial wait so the 9-minute join remains inside Codex's 10-minute tool envelope.
  const timeoutMs =
    params.actionParams.action === "send"
      ? Math.min(gateway.timeoutMs, MESSAGE_ACTION_INITIAL_SEND_TIMEOUT_MAX_MS)
      : gateway.timeoutMs;
  const call = {
    url: gateway.url,
    token: gateway.token,
    method: "message.action",
    params: params.actionParams,
    timeoutMs,
    signal: params.abortSignal,
    clientName: gateway.clientName,
    clientDisplayName: gateway.clientDisplayName,
    mode: gateway.mode,
    agentRuntimeIdentityToken,
  };
  try {
    return await callGatewayLeastPrivilege<T>(call);
  } catch (error) {
    if (
      !isGatewayTransportError(error) ||
      error.kind !== "timeout" ||
      params.actionParams.action !== "send"
    ) {
      throw error;
    }
    throwIfAborted(params.abortSignal);
  }

  const reconciliationSignal = params.abortSignal
    ? AbortSignal.any([
        params.abortSignal,
        AbortSignal.timeout(MESSAGE_ACTION_RECONCILIATION_MAX_MS),
      ])
    : undefined;
  const reconciliationCall = {
    ...call,
    // `null` keeps startup bounded but removes the per-request timer after
    // hello. The dedicated signal bounds a joined in-flight action without
    // reconnecting every minute or inheriting the run's much longer lifetime.
    timeoutMs: params.abortSignal
      ? null
      : Math.max(call.timeoutMs, MESSAGE_ACTION_RECONCILIATION_TIMEOUT_MS),
    signal: reconciliationSignal,
  };
  // A caller-side timeout does not cancel Gateway work. Reattach once with the
  // unchanged idempotency key so the live Gateway can join the original work.
  return await callGatewayLeastPrivilege<T>(reconciliationCall);
}

async function resolveGatewayActionIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageActionGatewayRuntime();
  return randomIdempotencyKey();
}
function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferPresentation,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferPresentation: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferPresentation,
  });
  params.message = applied.message;
  if (applied.presentation) {
    const existing = normalizeMessagePresentation(params.presentation);
    params.presentation = existing
      ? {
          ...existing,
          blocks: [...applied.presentation.blocks, ...existing.blocks],
        }
      : applied.presentation;
  }
  return applied.message;
}

async function maybeApplyCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  agentId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferPresentation: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
    agentId: params.agentId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferPresentation: params.preferPresentation,
  });
}

async function resolveChannel(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  toolContext?: { currentChannelProvider?: string },
) {
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: readStringParam(params, "channel"),
    fallbackChannel: toolContext?.currentChannelProvider,
  });
  if (selection.source === "tool-context-fallback") {
    params.channel = selection.channel;
  }
  return selection.channel;
}

function addCandidateAndUnprefixedAlias(candidates: Set<string>, value?: string | null) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return;
  }
  candidates.add(normalized);
  const unprefixed = normalized.replace(/^(channel|group|user):/i, "").trim();
  if (unprefixed && unprefixed !== normalized) {
    candidates.add(unprefixed);
  }
}

function normalizeTargetForAccountBinding(channel: ChannelId, target: string): string | undefined {
  try {
    return normalizeTargetForProvider(channel, target);
  } catch {
    return undefined;
  }
}

function inferPeerKindForAccountBinding(channel: ChannelId, target: string): ChatType | undefined {
  const inferred = normalizeChatType(
    getChannelPlugin(channel)?.messaging?.inferTargetChatType?.({ to: target }),
  );
  if (inferred) {
    return inferred;
  }
  const normalized = normalizeTargetForAccountBinding(channel, target);
  const candidates = [target, normalized].filter((value): value is string => Boolean(value));
  if (candidates.some((value) => /^user:/i.test(value))) {
    return "direct";
  }
  if (candidates.some((value) => /^(channel|group):/i.test(value))) {
    return "channel";
  }
  return undefined;
}

function resolveTargetBoundAccountId(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  args: Record<string, unknown>;
  agentId?: string;
}): string | undefined {
  if (!params.agentId) {
    return undefined;
  }
  const target =
    normalizeOptionalString(params.args.to) ?? normalizeOptionalString(params.args.channelId) ?? "";
  if (!target) {
    return resolveFirstBoundAccountId({
      cfg: params.cfg,
      channelId: params.channel,
      agentId: params.agentId,
    });
  }

  const candidates = new Set<string>();
  addCandidateAndUnprefixedAlias(candidates, target);
  addCandidateAndUnprefixedAlias(
    candidates,
    normalizeTargetForAccountBinding(params.channel, target),
  );
  const [peerId, ...exactPeerIdAliases] = Array.from(candidates);
  return resolveFirstBoundAccountId({
    cfg: params.cfg,
    channelId: params.channel,
    agentId: params.agentId,
    peerId,
    exactPeerIdAliases,
    peerKind: inferPeerKindForAccountBinding(params.channel, target),
  });
}

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = normalizeOptionalString(params.args.to) ?? "";
  if (toRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
    });
    params.args.to = resolved.to;
    resolvedTarget = resolved;
  }
  const channelIdRaw = normalizeOptionalString(params.args.channelId) ?? "";
  if (channelIdRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      preferredKind: "group",
      validateResolvedTarget: (target) =>
        target.kind === "user"
          ? `Channel id "${channelIdRaw}" resolved to a user target.`
          : undefined,
    });
    params.args.channelId = sanitizeGroupTargetId(resolved.to);
  }
  return resolvedTarget;
}

function sanitizeGroupTargetId(target: string): string {
  return target.replace(/^(channel|group):/i, "");
}

async function resolveResolvedTargetOrThrow(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string;
  preferredKind?: "group" | "user" | "channel";
  validateResolvedTarget?: (target: ResolvedMessagingTarget) => string | undefined;
}): Promise<ResolvedMessagingTarget> {
  const resolved = await resolveChannelTarget({
    cfg: params.cfg,
    channel: params.channel,
    input: params.input,
    accountId: params.accountId,
    preferredKind: params.preferredKind,
  });
  if (!resolved.ok) {
    throw resolved.error;
  }
  const validationError = params.validateResolvedTarget?.(resolved.target);
  if (validationError) {
    throw new Error(validationError);
  }
  return resolved.target;
}

type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  mediaAccess: OutboundMediaAccess;
  extraActionMediaSourceParamKeys?: readonly string[];
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  input: RunMessageActionParams;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};

type SendPayloadParts = {
  message: string;
  payload: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice: boolean;
  gifPlayback: boolean;
  forceDocument: boolean;
  bestEffort?: boolean;
  silent?: boolean;
};

function updateSendPayloadPartsFromReplyPayload(
  parts: SendPayloadParts,
  payload: ReplyPayload,
): SendPayloadParts {
  const sendable = resolveSendableOutboundReplyParts(payload);
  const mediaUrls = sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined;
  return {
    ...parts,
    message: payload.text ?? "",
    payload,
    mediaUrl: mediaUrls?.[0],
    mediaUrls,
    asVoice: payload.audioAsVoice === true,
  };
}

function applySendPayloadPartsToActionParams(
  actionParams: Record<string, unknown>,
  parts: SendPayloadParts,
) {
  if (parts.message || !parts.payload.presentation) {
    actionParams.message = parts.message;
  } else {
    // Presentation-only gateway handlers distinguish an omitted body from an
    // explicit empty body when deciding whether to render semantic fallback.
    delete actionParams.message;
  }
  actionParams.media = parts.mediaUrl;
  actionParams.mediaUrl = parts.mediaUrl;
  actionParams.mediaUrls = parts.mediaUrls;
  actionParams.asVoice = parts.asVoice || undefined;
  actionParams.audioAsVoice = parts.asVoice || undefined;
  actionParams.asVideoNote = parts.payload.videoAsNote || undefined;
  actionParams.location = parts.payload.location;
}

function collectMessageAttachmentMediaHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  const pushMedia = (entry: unknown) => {
    const normalized = normalizeOptionalString(entry);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    mediaUrls.push(normalized);
  };
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    pushMedia(record.media);
    pushMedia(record.mediaUrl);
    pushMedia(record.path);
    pushMedia(record.filePath);
    pushMedia(record.fileUrl);
    pushMedia(record.url);
  }
  return mediaUrls;
}

function hasExplicitSingularTargetParam(params: Record<string, unknown>): boolean {
  return readTrimmedStringAlias(params, ["target", "to", "channelId"]) !== undefined;
}

function hasExplicitTargetParam(params: Record<string, unknown>): boolean {
  return (
    hasExplicitSingularTargetParam(params) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => normalizeOptionalString(value)))
  );
}

function hasPotentialActionTargetInput(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): boolean {
  return Boolean(
    hasExplicitSingularTargetParam(params) ||
    normalizeOptionalString(input.toolContext?.currentChannelId) ||
    normalizeOptionalString(input.toolContext?.currentMessagingTarget) ||
    hasPotentialPluginActionParam(params),
  );
}

function isCurrentSourceTargetParam(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): boolean {
  const currentChannelId = normalizeOptionalString(input.toolContext?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(input.toolContext?.currentMessagingTarget);
  if (!currentChannelId && !currentMessagingTarget) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (explicitChannel && currentChannelProvider && explicitChannel !== currentChannelProvider) {
    return false;
  }

  const explicitTarget =
    normalizeOptionalString(params.target) ??
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.channelId);
  if (!explicitTarget) {
    return false;
  }

  const provider = explicitChannel ?? currentChannelProvider;
  const currentCandidates = new Set<string>();
  for (const currentTarget of [currentMessagingTarget, currentChannelId]) {
    if (!currentTarget) {
      continue;
    }
    addCandidateAndUnprefixedAlias(currentCandidates, currentTarget);
    if (provider) {
      addCandidateAndUnprefixedAlias(
        currentCandidates,
        normalizeTargetForAccountBinding(provider, currentTarget),
      );
    }
  }

  const explicitCandidates = new Set<string>();
  addCandidateAndUnprefixedAlias(explicitCandidates, explicitTarget);
  if (provider) {
    addCandidateAndUnprefixedAlias(
      explicitCandidates,
      normalizeTargetForAccountBinding(provider, explicitTarget),
    );
  }
  return Array.from(explicitCandidates).some((candidate) => currentCandidates.has(candidate));
}

function hasExplicitNonCurrentChannelParam(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): boolean {
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (!explicitChannel) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  return !currentChannelProvider || explicitChannel !== currentChannelProvider;
}

function applyImplicitSourceReplySendPolicy(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
) {
  if (input.action !== "send" || input.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  if (hasExplicitNonCurrentChannelParam(input, params)) {
    return;
  }
  if (hasExplicitTargetParam(params) && !isCurrentSourceTargetParam(input, params)) {
    return;
  }
  params.bestEffort = true;
}

async function runGatewayPluginMessageActionOrNull(params: {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  action: ChannelMessageActionName;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  input: RunMessageActionParams;
  agentId?: string;
  result: (payload: unknown) => MessageActionRunResult;
}): Promise<MessageActionRunResult | null> {
  if (params.dryRun || !params.gateway) {
    return null;
  }
  const plugin = resolveOutboundChannelPlugin({ channel: params.channel, cfg: params.cfg });
  if (!plugin?.actions?.handleAction) {
    return null;
  }
  const executionMode = plugin.actions.resolveExecutionMode?.({ action: params.action }) ?? "local";
  if (executionMode !== "gateway") {
    return null;
  }
  const conversationReadOrigin = normalizeConversationReadInvocationOrigin(
    params.input.conversationReadOrigin,
  );
  const payload = await callGatewayMessageAction<unknown>({
    gateway: params.gateway,
    abortSignal: params.input.abortSignal,
    actionParams: {
      channel: params.channel,
      action: params.action,
      params: params.params,
      accountId: params.accountId ?? undefined,
      senderIsOwner: params.input.senderIsOwner,
      sessionKey: params.input.sessionKey,
      sessionId: params.input.sessionId,
      inboundTurnKind: params.input.inboundEventKind,
      agentId: params.agentId,
      ...(conversationReadOrigin === "direct-operator" ? { conversationReadOrigin } : {}),
      idempotencyKey: await resolveGatewayActionIdempotencyKey(
        normalizeOptionalString(params.params.idempotencyKey),
      ),
    },
  });
  return params.result(payload);
}

function resolveGateway(input: RunMessageActionParams): MessageActionRunnerGateway | undefined {
  if (!input.gateway) {
    return undefined;
  }
  return {
    url: input.gateway.url,
    token: input.gateway.token,
    timeoutMs: input.gateway.timeoutMs,
    clientName: input.gateway.clientName,
    clientDisplayName: input.gateway.clientDisplayName,
    mode: input.gateway.mode,
    resolveAgentRuntimeIdentityToken: input.gateway.resolveAgentRuntimeIdentityToken,
  };
}

async function handleBroadcastAction(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): Promise<MessageActionRunResult> {
  throwIfAborted(input.abortSignal);
  const broadcastEnabled =
    resolveEffectiveMessageToolsConfig({ cfg: input.cfg, agentId: input.agentId })?.broadcast
      ?.enabled !== false;
  if (!broadcastEnabled) {
    throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
  }
  const rawTargets = readStringArrayParam(params, "targets", { required: true });
  if (rawTargets.length === 0) {
    throw new Error("Broadcast requires at least one target in --targets.");
  }
  const channelHint = readStringParam(params, "channel");
  const targetChannels =
    channelHint && normalizeOptionalLowercaseString(channelHint) !== "all"
      ? [await resolveChannel(input.cfg, { channel: channelHint }, input.toolContext)]
      : await (async () => {
          const configured = await listConfiguredMessageChannels(input.cfg);
          if (configured.length === 0) {
            throw new Error("Broadcast requires at least one configured channel.");
          }
          return configured;
        })();
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    sentBeforeError?: true;
    payload?: unknown;
    result?: MessageSendResult;
  }> = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  for (const targetChannel of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      try {
        const resolved = await resolveResolvedTargetOrThrow({
          cfg: input.cfg,
          channel: targetChannel,
          input: target,
        });
        const sendResult = await runMessageAction({
          ...input,
          action: "send",
          params: {
            ...params,
            channel: targetChannel,
            target: resolved.to,
          },
        });
        results.push({
          channel: targetChannel,
          to: resolved.to,
          ok: true,
          payload: sendResult.kind === "send" ? sendResult.payload : undefined,
          result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        results.push({
          channel: targetChannel,
          to: target,
          ok: false,
          error: formatErrorMessage(err),
          ...(err &&
          typeof err === "object" &&
          (err as { sentBeforeError?: unknown }).sentBeforeError === true
            ? { sentBeforeError: true as const }
            : {}),
        });
      }
    }
  }
  return {
    kind: "broadcast",
    channel: targetChannels[0] ?? normalizeOptionalLowercaseString(channelHint) ?? "unknown",
    action: "broadcast",
    handledBy: input.dryRun ? "dry-run" : "core",
    payload: { results },
    dryRun: Boolean(input.dryRun),
  };
}

async function handleInternalSourceReplySendAction(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): Promise<MessageActionRunResult> {
  throwIfAborted(input.abortSignal);
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const sourceReply = await buildSendPayloadParts({
    cfg: input.cfg,
    actionParams: params,
    input,
    agentId:
      input.agentId ??
      (input.sessionKey
        ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: input.cfg })
        : undefined),
  });
  const payload = {
    status: "ok",
    deliveryStatus: dryRun ? "dry_run" : "sent",
    channel: INTERNAL_MESSAGE_CHANNEL,
    target: "current-run",
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
    ...(dryRun ? {} : { sourceReplySink: "internal-ui" as const }),
    sourceReply: sourceReply.payload,
    ...(sourceReply.message ? { message: sourceReply.message } : {}),
    ...(sourceReply.mediaUrl ? { mediaUrl: sourceReply.mediaUrl } : {}),
    ...(sourceReply.mediaUrls?.length ? { mediaUrls: sourceReply.mediaUrls } : {}),
    dryRun,
  };
  return {
    kind: "send",
    channel: INTERNAL_MESSAGE_CHANNEL,
    action: "send",
    to: "current-run",
    handledBy: "internal-source",
    payload,
    toolResult: buildInternalSourceReplyToolResult(payload),
    dryRun,
  };
}

function buildInternalSourceReplyToolResult(payload: {
  status: string;
  deliveryStatus: string;
  channel: ChannelId;
  target: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sourceReplySink?: "internal-ui";
  sourceReply: ReplyPayload;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  dryRun: boolean;
}): AgentToolResult<{
  status: string;
  deliveryStatus: string;
  channel: ChannelId;
  target: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sourceReplySink?: "internal-ui";
  sourceReply: ReplyPayload;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  dryRun: boolean;
}> {
  const action = payload.dryRun ? "Prepared" : "Sent";
  const sink = payload.sourceReplySink ? ` via ${payload.sourceReplySink}` : "";
  return {
    content: [
      {
        type: "text",
        text: `${action} visible reply to the current source conversation${sink}.`,
      },
    ],
    details: {
      status: payload.status,
      deliveryStatus: payload.deliveryStatus,
      channel: payload.channel,
      target: payload.target,
      ...(payload.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: payload.sourceReplyDeliveryMode }
        : {}),
      ...(payload.sourceReplySink ? { sourceReplySink: payload.sourceReplySink } : {}),
      sourceReply: payload.sourceReply,
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
      ...(payload.mediaUrls?.length ? { mediaUrls: payload.mediaUrls } : {}),
      dryRun: payload.dryRun,
    },
  };
}

async function buildSendPayloadParts(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  input: RunMessageActionParams;
  channel?: ChannelId;
  target?: string;
  accountId?: string | null;
  agentId?: string;
}): Promise<SendPayloadParts> {
  const { actionParams, input } = params;
  if (actionParams.pin === true && actionParams.delivery == null) {
    actionParams.delivery = { pin: { enabled: true } };
  }
  // Models may emit message body under non-canonical aliases.
  if (typeof actionParams.message !== "string" || !actionParams.message.trim()) {
    for (const alias of ["SendMessage", "content", "text"] as const) {
      const value = actionParams[alias];
      if (typeof value === "string" && value.trim()) {
        actionParams.message = stripFormattedReasoningMessage(value);
        console.warn(`[message-tool] normalized alias "${alias}" to "message" for send action`);
        break;
      }
    }
  }
  const mediaHint =
    readStringParam(actionParams, "media", { trim: false }) ??
    readStringParam(actionParams, "mediaUrl", { trim: false }) ??
    readStringParam(actionParams, "path", { trim: false }) ??
    readStringParam(actionParams, "filePath", { trim: false }) ??
    readStringParam(actionParams, "fileUrl", { trim: false }) ??
    readStringParam(actionParams, "image", { trim: false });
  const mediaUrlHints = readStringArrayParam(actionParams, "mediaUrls") ?? [];
  const attachmentMediaHints = collectMessageAttachmentMediaHints(actionParams.attachments);
  const hasMediaHint =
    Boolean(mediaHint) || mediaUrlHints.length > 0 || attachmentMediaHints.length > 0;
  const hasPresentation = hasMessagePresentationBlocks(actionParams.presentation);
  const hasInteractive = hasInteractiveReplyBlocks(actionParams.interactive);
  const location = normalizeOutboundLocation(actionParams.location);
  const caption = readStringParam(actionParams, "caption", { allowEmpty: true }) ?? "";
  let message =
    readStringParam(actionParams, "message", {
      required: !hasMediaHint && !hasPresentation && !hasInteractive && !location,
      allowEmpty: true,
    }) ?? "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }

  const parsed = parseInlineDirectives(message, {
    stripAudioTag: true,
    stripReplyTags: true,
  });
  const mergedMediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  const pushMedia = (value?: string | null) => {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed || seenMedia.has(trimmed)) {
      return;
    }
    seenMedia.add(trimmed);
    mergedMediaUrls.push(trimmed);
  };
  pushMedia(mediaHint);
  for (const mediaUrlHint of mediaUrlHints) {
    pushMedia(mediaUrlHint);
  }
  for (const attachmentMediaHint of attachmentMediaHints) {
    pushMedia(attachmentMediaHint);
  }

  const normalizedMediaUrls = await normalizeSandboxMediaList({
    values: mergedMediaUrls,
    sandboxRoot: input.sandboxRoot,
  });
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...normalizedMediaUrls);

  message = stripPlainTextToolCallBlocks(stripUnsupportedCitationControlMarkers(parsed.text));
  if (message || !hasPresentation) {
    actionParams.message = message;
  } else {
    delete actionParams.message;
  }
  if (!actionParams.replyTo && parsed.replyToId) {
    actionParams.replyTo = parsed.replyToId;
  }
  if (!actionParams.media) {
    actionParams.media = mergedMediaUrls[0] || undefined;
  }
  actionParams.mediaUrls = mergedMediaUrls.length > 0 ? [...mergedMediaUrls] : undefined;

  if (
    location &&
    (message.trim() || mergedMediaUrls.length > 0 || hasPresentation || hasInteractive)
  ) {
    throw new Error("Location sends cannot be combined with message text or media.");
  }

  if (params.channel && params.target) {
    message = await maybeApplyCrossContextMarker({
      cfg: params.cfg,
      channel: params.channel,
      action: "send",
      target: params.target,
      toolContext: input.toolContext,
      accountId: params.accountId,
      agentId: params.agentId,
      args: actionParams,
      message,
      preferPresentation: true,
    });
  }

  const mediaUrl = readStringParam(actionParams, "media", { trim: false });
  if (
    !hasReplyPayloadContent({
      text: message,
      mediaUrl,
      mediaUrls: mergedMediaUrls,
      presentation: actionParams.presentation,
      interactive: actionParams.interactive,
      location,
    })
  ) {
    throw new Error("send requires text or media or location");
  }
  if (message || !hasPresentation) {
    actionParams.message = message;
  } else {
    delete actionParams.message;
  }
  const gifPlayback = readBooleanParam(actionParams, "gifPlayback") ?? false;
  const forceDocument =
    readBooleanParam(actionParams, "forceDocument") ??
    readBooleanParam(actionParams, "asDocument") ??
    false;
  const asVoice =
    readBooleanParam(actionParams, "asVoice") ??
    readBooleanParam(actionParams, "audioAsVoice") ??
    parsed.audioAsVoice;
  const asVideoNote = readBooleanParam(actionParams, "asVideoNote") ?? false;
  const bestEffort = readBooleanParam(actionParams, "bestEffort");
  const silent = readBooleanParam(actionParams, "silent");
  const mirrorMediaUrls =
    mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
  const rawDelivery = actionParams.delivery;
  const delivery =
    rawDelivery && typeof rawDelivery === "object" && !Array.isArray(rawDelivery)
      ? (rawDelivery as ReplyPayloadDelivery)
      : undefined;
  const rawChannelData = actionParams.channelData;
  const channelData =
    rawChannelData && typeof rawChannelData === "object" && !Array.isArray(rawChannelData)
      ? (rawChannelData as Record<string, unknown>)
      : undefined;
  const presentation = normalizeMessagePresentation(actionParams.presentation);
  const interactive = normalizeInteractiveReply(actionParams.interactive);
  return {
    message,
    payload: {
      text: message,
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(mergedMediaUrls.length ? { mediaUrls: mergedMediaUrls } : {}),
      ...(asVoice ? { audioAsVoice: true } : {}),
      ...(asVideoNote ? { videoAsNote: true } : {}),
      ...(location ? { location } : {}),
      ...(presentation ? { presentation } : {}),
      ...(interactive ? { interactive } : {}),
      ...(delivery ? { delivery } : {}),
      ...(channelData ? { channelData } : {}),
    },
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mirrorMediaUrls ? { mediaUrls: mirrorMediaUrls } : {}),
    asVoice,
    gifPlayback,
    forceDocument,
    ...(bestEffort !== undefined ? { bestEffort } : {}),
    ...(silent !== undefined ? { silent } : {}),
  };
}

// Detects leftover `{variable}` placeholders after prefix interpolation. Non-global so
// `.test()` stays stateless; mirrors the variable shape in response-prefix-template.ts.
const UNRESOLVED_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

async function handleSendAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const {
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    resolvedTarget,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "send";
  const to = readStringParam(params, "to", { required: true });
  let sendPayload = await buildSendPayloadParts({
    cfg,
    actionParams: params,
    input,
    channel,
    target: to,
    accountId,
    agentId,
  });

  // `message(action=send)` crosses into other conversations, so mirror the direct-reply
  // egress and prepend messages.responsePrefix here too; otherwise the disambiguation
  // prefix is silently dropped on tool sends while replies keep it. Interpolate the
  // template like normalize-reply.ts so identity tokens render. model/provider/thinking
  // tokens need the live model selection that a tool send never performs, so when any
  // placeholder stays unresolved we skip prefixing instead of leaking a literal `{model}`.
  // The startsWith guard matches normalize-reply.ts and keeps re-runs idempotent.
  const responsePrefix = resolveResponsePrefixTemplate(
    resolveResponsePrefix(cfg, agentId ?? "", {
      channel,
      accountId: accountId ?? undefined,
    }),
    { identityName: normalizeOptionalString(resolveAgentIdentity(cfg, agentId ?? "")?.name) },
  );
  const prefixHasUnresolvedVar =
    responsePrefix !== undefined && UNRESOLVED_PREFIX_VAR_PATTERN.test(responsePrefix);
  if (
    responsePrefix &&
    !prefixHasUnresolvedVar &&
    sendPayload.message &&
    !sendPayload.message.startsWith(responsePrefix)
  ) {
    const prefixedMessage = `${responsePrefix} ${sendPayload.message}`;
    sendPayload = {
      ...sendPayload,
      message: prefixedMessage,
      payload: { ...sendPayload.payload, text: prefixedMessage },
    };
    applySendPayloadPartsToActionParams(params, sendPayload);
  }

  const replyToIsExplicit = Boolean(readStringParam(params, "replyTo"));
  resolveAndApplyOutboundReplyToId(params, {
    channel,
    toolContext: input.toolContext,
    matchesToolContextTarget: getChannelPlugin(channel)?.threading?.matchesToolContextTarget,
  });
  const { resolvedThreadId, outboundRoute } = await prepareOutboundMirrorRoute({
    cfg,
    channel,
    to,
    actionParams: params,
    accountId,
    toolContext: input.toolContext,
    agentId,
    currentSessionKey: input.sessionKey,
    dryRun,
    resolvedTarget,
    resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
    resolveReplyTransport: getChannelPlugin(channel)?.threading?.resolveReplyTransport,
    replyToIsExplicit,
    resolveOutboundSessionRoute,
    ensureOutboundSessionEntry,
  });
  const resolvedReplyToId = readStringParam(params, "replyTo");
  throwIfAborted(abortSignal);

  const ttsPayload = await maybeApplyTtsToMessageActionSendPayload({
    payload: sendPayload.payload,
    cfg,
    channel,
    accountId,
    agentId,
    sessionKey: input.sessionKey,
    inboundAudio: input.inboundAudio,
    dryRun,
  });
  if (ttsPayload !== sendPayload.payload) {
    sendPayload = updateSendPayloadPartsFromReplyPayload(sendPayload, ttsPayload);
    applySendPayloadPartsToActionParams(params, sendPayload);
  }
  throwIfAborted(abortSignal);
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg,
    agentId,
    mediaSources: collectActionMediaSourceHints(params, ctx.extraActionMediaSourceParamKeys, {
      structuredAttachments: "all",
    }),
    sessionKey: input.sessionKey,
    messageProvider: input.sessionKey ? undefined : channel,
    accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
    requesterSenderId: input.requesterSenderId,
    requesterSenderName: input.requesterSenderName,
    requesterSenderUsername: input.requesterSenderUsername,
    requesterSenderE164: input.requesterSenderE164,
  });

  // Gateway action ownership wins even when this process has a render-capable
  // outbound adapter; credentials and account selection may exist only remotely.
  const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
    cfg,
    params,
    channel,
    action,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    result: (payload) => ({
      kind: "send",
      channel,
      action,
      to,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  if (gatewayPluginAction) {
    return gatewayPluginAction;
  }

  const useCorePresentationDelivery = Boolean(
    sendPayload.payload.presentation &&
    hasCorePresentationDelivery(resolveOutboundChannelPlugin({ channel, cfg })?.outbound),
  );
  if (sendPayload.payload.presentation && !useCorePresentationDelivery) {
    const fallbackMessage = materializeMessagePresentationFallback({
      payload: sendPayload.payload,
      text: sendPayload.message,
    });
    sendPayload = {
      ...sendPayload,
      message: fallbackMessage,
      payload: { ...sendPayload.payload, text: fallbackMessage },
    };
    applySendPayloadPartsToActionParams(params, sendPayload);
  }

  const send = await executeSendAction({
    ctx: {
      cfg,
      channel,
      params,
      agentId,
      sessionKey: input.sessionKey,
      requesterAccountId: input.requesterAccountId ?? undefined,
      requesterSenderId: input.requesterSenderId ?? undefined,
      requesterSenderName: input.requesterSenderName ?? undefined,
      requesterSenderUsername: input.requesterSenderUsername ?? undefined,
      requesterSenderE164: input.requesterSenderE164 ?? undefined,
      senderIsOwner: input.senderIsOwner,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      mediaAccess,
      accountId: accountId ?? undefined,
      conversationType: outboundRoute?.chatType,
      sessionId: input.sessionId,
      inboundEventKind: input.inboundEventKind,
      gateway,
      toolContext: input.toolContext,
      deps: input.deps,
      dryRun,
      mirror:
        outboundRoute && !dryRun
          ? {
              sessionKey: outboundRoute.sessionKey,
              agentId,
              text: sendPayload.message,
              mediaUrls: sendPayload.mediaUrls,
              idempotencyKey: normalizeOptionalString(params.idempotencyKey) ?? undefined,
            }
          : undefined,
      abortSignal,
      silent: sendPayload.silent ?? undefined,
    },
    to,
    message: sendPayload.message,
    payload: sendPayload.payload,
    mediaUrl: sendPayload.mediaUrl,
    mediaUrls: sendPayload.mediaUrls,
    buffer: readStringParam(params, "buffer", { trim: false }) ?? undefined,
    filename: readStringParam(params, "filename") ?? undefined,
    contentType: readStringParam(params, "contentType") ?? undefined,
    asVoice: sendPayload.asVoice,
    gifPlayback: sendPayload.gifPlayback,
    forceDocument: sendPayload.forceDocument,
    bestEffort: sendPayload.bestEffort,
    replyToId: resolvedReplyToId ?? undefined,
    replyToIdSource: resolvedReplyToId ? (replyToIsExplicit ? "explicit" : "implicit") : undefined,
    threadId: resolvedThreadId ?? undefined,
  });

  return {
    kind: "send",
    channel,
    action,
    to,
    handledBy: send.handledBy,
    payload: send.payload,
    toolResult: send.toolResult,
    sendResult: send.sendResult,
    dryRun,
  };
}

async function handlePollAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, agentId, abortSignal } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readStringParam(params, "to", { required: true });
  const silent = readBooleanParam(params, "silent");

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    to,
    accountId,
    toolContext: input.toolContext,
    resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
  });

  const base = typeof params.message === "string" ? params.message : "";
  await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    agentId,
    args: params,
    message: base,
    preferPresentation: false,
  });

  const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
    cfg,
    params,
    channel,
    action,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    result: (payload) => ({
      kind: "poll",
      channel,
      action,
      to,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  if (gatewayPluginAction) {
    return gatewayPluginAction;
  }

  const poll = await executePollAction({
    ctx: {
      cfg,
      channel,
      params,
      accountId: accountId ?? undefined,
      agentId,
      requesterAccountId: input.requesterAccountId ?? undefined,
      requesterSenderId: input.requesterSenderId ?? undefined,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      inboundEventKind: input.inboundEventKind,
      gateway,
      toolContext: input.toolContext,
      dryRun,
      silent: silent ?? undefined,
    },
    resolveCorePoll: () => {
      const question = readStringParam(params, "pollQuestion", {
        required: true,
      });
      const options = readStringArrayParam(params, "pollOption", { required: true });
      if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
      }
      const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
      const durationHours = readPositiveIntegerParam(params, "pollDurationHours", {
        message: "pollDurationHours must be a positive integer",
      });

      return {
        to,
        question,
        options,
        maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
      };
    },
  });

  return {
    kind: "poll",
    channel,
    action,
    to,
    handledBy: poll.handledBy,
    payload: poll.payload,
    toolResult: poll.toolResult,
    pollResult: poll.pollResult,
    dryRun,
  };
}

async function handlePluginAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const {
    cfg,
    params,
    channel,
    mediaAccess,
    accountId,
    dryRun,
    gateway,
    input,
    abortSignal,
    agentId,
  } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  if (!plugin?.actions?.handleAction) {
    throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
  }

  // Plugin actions bypass send/poll, so inherit thread metadata before either
  // gateway or local dispatch to keep both execution modes on the same topic.
  const targetForThreading =
    normalizeOptionalString(params.to) ?? normalizeOptionalString(params.channelId) ?? "";
  if (targetForThreading) {
    resolveAndApplyOutboundThreadId(params, {
      cfg,
      to: targetForThreading,
      accountId,
      toolContext: input.toolContext,
      resolveAutoThreadId: plugin.threading?.resolveAutoThreadId,
      resolveReplyTransport: plugin.threading?.resolveReplyTransport,
      replyToIsExplicit: Boolean(readStringParam(params, "replyTo")),
    });
  }

  const gatewayPluginAction = await runGatewayPluginMessageActionOrNull({
    cfg,
    params,
    channel,
    action,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    result: (payload) => ({
      kind: "action",
      channel,
      action,
      handledBy: "plugin",
      payload,
      dryRun,
    }),
  });
  if (gatewayPluginAction) {
    // Gateway-owned actions must execute where the live channel runtime exists.
    return gatewayPluginAction;
  }

  const authorization = input.messageActionAuthorization;
  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    mediaAccess,
    mediaLocalRoots: mediaAccess.localRoots,
    mediaReadFile: mediaAccess.readFile,
    accountId: accountId ?? undefined,
    requesterAccountId:
      authorization !== undefined
        ? authorization.requesterAccountId
        : (input.requesterAccountId ?? undefined),
    requesterSenderId:
      authorization !== undefined
        ? authorization.requesterSenderId
        : (input.requesterSenderId ?? undefined),
    senderIsOwner: input.senderIsOwner,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(input.conversationReadOrigin),
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    inboundEventKind: input.inboundEventKind,
    agentId,
    gateway,
    toolContext: authorization !== undefined ? authorization.toolContext : input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
    dryRun,
  };
}

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  let params = { ...input.params };
  const resolvedAgentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
      : undefined);
  parseJsonMessageParam(params, "presentation");
  parseJsonMessageParam(params, "delivery");
  parseInteractiveParam(params);

  const action = input.action;
  enforceMessageActionAllowlist({
    cfg,
    agentId: resolvedAgentId,
    action,
  });
  if (action === "broadcast") {
    return handleBroadcastAction(input, params);
  }
  if (action === "send" && hasPollCreationParams(params)) {
    throw new Error('Poll fields require action "poll"; use action "poll" instead of "send".');
  }
  if (await shouldUseInternalSourceReplySink(input, params)) {
    return handleInternalSourceReplySendAction({ ...input, agentId: resolvedAgentId }, params);
  }
  applyImplicitSourceReplySendPolicy(input, params);
  // Missing targets must fail before channel discovery, which can bootstrap or
  // probe configured plugins. Non-standard params may still be owner aliases.
  if (actionRequiresTarget(action) && !hasPotentialActionTargetInput(input, params)) {
    throw new Error(`Action ${action} requires a target.`);
  }
  const channel = await resolveChannel(cfg, params, input.toolContext);
  params.channel = channel;
  const channelPlugin = resolveOutboundChannelPlugin({ channel, cfg });
  const pluginOwnedAction = action !== "send" && action !== "poll";
  if (
    pluginOwnedAction &&
    channelPlugin?.actions?.supportsAction &&
    !channelPlugin.actions.supportsAction({ action })
  ) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  params = normalizeMessageActionInput({
    action,
    args: params,
    toolContext: input.toolContext,
    targetAliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[action],
  });
  let accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
  if (!accountId && resolvedAgentId) {
    accountId = resolveTargetBoundAccountId({
      cfg,
      channel,
      args: params,
      agentId: resolvedAgentId,
    });
  }
  if (accountId) {
    params.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const normalizationPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, resolvedAgentId),
  });
  const extraActionMediaSourceParamKeys = resolveExtraActionMediaSourceParamKeys({
    cfg,
    action,
    args: params,
    channel,
    accountId,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    agentId: resolvedAgentId,
    requesterSenderId: input.requesterSenderId,
    senderIsOwner: input.senderIsOwner,
  });
  const structuredAttachmentMode = action === "send" ? "all" : "selected";

  await normalizeSandboxMediaParams({
    args: params,
    mediaPolicy: normalizationPolicy,
    extraParamKeys: extraActionMediaSourceParamKeys,
    structuredAttachments: structuredAttachmentMode,
  });

  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg,
    agentId: resolvedAgentId,
    mediaSources: collectActionMediaSourceHints(params, extraActionMediaSourceParamKeys, {
      structuredAttachments: structuredAttachmentMode,
    }),
    sessionKey: input.sessionKey,
    messageProvider: input.sessionKey ? undefined : channel,
    accountId: input.sessionKey ? (input.requesterAccountId ?? accountId) : accountId,
    requesterSenderId: input.requesterSenderId,
    requesterSenderName: input.requesterSenderName,
    requesterSenderUsername: input.requesterSenderUsername,
    requesterSenderE164: input.requesterSenderE164,
  });
  const mediaPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaAccess,
  });
  const gateway = resolveGateway(input);
  const preserveSendBuffer =
    action === "send" &&
    Boolean(gateway) &&
    (channelPlugin?.actions?.resolveExecutionMode?.({
      action: "send",
    }) === "gateway" ||
      channelPlugin?.outbound?.deliveryMode === "gateway");

  const hydrateActionAttachmentParams = () =>
    hydrateAttachmentParamsForAction({
      cfg,
      channel,
      accountId,
      args: params,
      action,
      dryRun,
      preserveSendBuffer,
      mediaPolicy,
      extraParamKeys: extraActionMediaSourceParamKeys,
    });

  if (action !== "send") {
    await hydrateActionAttachmentParams();
  }

  const resolvedTarget = await resolveActionTarget({
    cfg,
    channel,
    action,
    args: params,
    accountId,
  });

  enforceCrossContextPolicy({
    channel,
    action,
    args: params,
    toolContext: input.toolContext,
    cfg,
    agentId: resolvedAgentId,
  });

  if (action === "send") {
    await hydrateActionAttachmentParams();
  }

  if (action === "send") {
    return handleSendAction({
      cfg,
      params,
      channel,
      mediaAccess,
      extraActionMediaSourceParamKeys,
      accountId,
      dryRun,
      gateway,
      input,
      agentId: resolvedAgentId,
      resolvedTarget,
      abortSignal: input.abortSignal,
    });
  }

  if (action === "poll") {
    return handlePollAction({
      cfg,
      params,
      channel,
      mediaAccess,
      extraActionMediaSourceParamKeys,
      accountId,
      dryRun,
      gateway,
      input,
      abortSignal: input.abortSignal,
    });
  }

  return handlePluginAction({
    cfg,
    params,
    channel,
    mediaAccess,
    extraActionMediaSourceParamKeys,
    accountId,
    dryRun,
    gateway,
    input,
    agentId: resolvedAgentId,
    abortSignal: input.abortSignal,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
