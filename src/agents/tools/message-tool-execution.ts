import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { sha256Base64UrlPrefix } from "../../infra/crypto-digest.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveMessageBroadcastAccountPlan,
  validateExplicitMessageAccountSelection,
} from "../../infra/outbound/message-account-selection.js";
import type {
  MessageActionGateway,
  MessageActionResult,
} from "../../infra/outbound/message-action-contracts.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  actionRequiresTarget,
  resolveActionDeliveryTargetAlias,
} from "../../infra/outbound/message-action-spec.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  asToolParamsRecord,
  type AnyAgentTool,
  jsonResult,
  readToolStringParam,
} from "./common.js";
import {
  readGatewayCallOptions,
  resolveGatewayOptions,
  resolveMessageActionAgentRuntimeIdentityToken,
  type GatewayCallOptions,
} from "./gateway.js";
import { createMessageToolDecisionRecorder } from "./message-tool-decision.js";
import { appendMessageToolVisibleReplyHint } from "./message-tool-description.js";
import {
  buildMessageToolDescription,
  buildMessageToolSchema,
  type MessageToolDiscoveryParams,
  resolveAgentAccountId,
  resolveEffectiveCurrentChannelContext,
  resolveMessageToolActionSchemaActions,
} from "./message-tool-discovery.js";
import { MessageToolSchema } from "./message-tool-schema.js";
import {
  addSourceReplyFinalControl,
  enforceSourceReplyOnlyMessageAction,
  enforceSourceReplyOnlyTextDirectives,
  enforceTrustedTurnExplicitAccount,
  SOURCE_REPLY_ONLY_MESSAGE_SCHEMA,
} from "./message-tool-source-policy.js";
import {
  hasSanitizedSendPayloadContent,
  sanitizeMessageToolVisiblePayload,
  type VisibleTextSuppressionReason,
} from "./message-tool-visible-content.js";
import { isPollVoteEchoText } from "./poll-vote-echo.js";

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return action === "broadcast" || actionRequiresTarget(action);
}

type ExplicitMessageTargetContext = {
  currentChannelProvider?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

function requireExplicitMessageTarget(
  params: Record<string, unknown>,
  context?: ExplicitMessageTargetContext,
): void {
  const action = readToolStringParam(params, "action", {
    required: true,
  }) as ChannelMessageActionName;
  if (!actionNeedsExplicitTarget(action)) {
    return;
  }
  const hasCanonicalTarget =
    (typeof params.target === "string" && params.target.trim().length > 0) ||
    (typeof params.to === "string" && params.to.trim().length > 0) ||
    (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
  if (hasCanonicalTarget) {
    return;
  }
  const channel =
    normalizeMessageChannel(normalizeOptionalString(params.channel)) ??
    normalizeMessageChannel(context?.currentChannelProvider);
  const plugin = channel ? context?.preparedMessageToolCatalog?.getChannel(channel) : undefined;
  const aliasSpec = plugin?.actions?.messageActionTargetAliases?.[action];
  if (
    channel &&
    aliasSpec &&
    resolveActionDeliveryTargetAlias(action, params, { channel, aliasSpec })
  ) {
    return;
  }
  throw new MessageActionDeniedError(
    "Explicit message target required for this run. Provide target/targets (and channel when needed).",
    "message_target_missing",
    "message-target:explicit",
  );
}

function normalizeMessageToolIdempotencyKeyPart(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/[^A-Za-z0-9._:-]+/gu, "_");
}

const MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_NAMES = [
  "gatewayToken",
  "gatewayUrl",
  "idempotencyKey",
  "timeoutMs",
] satisfies Array<keyof GatewayCallOptions | "idempotencyKey">;
const MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS = new Set<string>(
  MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_NAMES,
);

function stripMessageToolIdempotencyEnvelope(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params).toSorted()) {
    if (!MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS.has(key)) {
      out[key] = params[key];
    }
  }
  return out;
}

function canonicalizeMessageToolIdempotencyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeMessageToolIdempotencyValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    out[key] = canonicalizeMessageToolIdempotencyValue(record[key]);
  }
  return out;
}

function buildMessageToolDeliveryFingerprint(params: {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(
    canonicalizeMessageToolIdempotencyValue({
      action: params.action,
      params: stripMessageToolIdempotencyEnvelope(params.params),
    }),
  );
  return sha256Base64UrlPrefix(canonical, 24);
}

function buildMessageToolAutogeneratedIdempotencyKey(params: {
  runId: string;
  deliveryFingerprint: string;
  operationId: string;
}): string {
  return `${params.runId}:message-tool:${params.deliveryFingerprint}:${params.operationId}`;
}

const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Keyed by agent session (conversation), NOT per message-tool instance: a native
// poll and its accompanying comment arrive as separate inbound messages and are
// processed in separate agent runs, each with a fresh tool instance. An
// instance-local record would be lost before the follow-up text run, so the echo
// (the agent restating its vote in prose) would leak. Session-scoped +
// route-checked storage lets the vote in one run suppress the restatement in the
// next while never crossing conversations. Single slot per session, TTL-bounded.
const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

function resolvePollVoteEchoRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return undefined;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId].filter((value): value is string =>
      Boolean(value),
    ),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core.
  // A route mismatch fails open; provider/account keys prevent cross-send suppression.
  const routeTarget = !target || currentTargets.has(target) ? "<current-source>" : target;
  return `${channel}\0${normalizeAccountId(params.accountId ?? "default")}\0${routeTarget}`;
}

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  runSessionKey?: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  config?: OpenClawConfig;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
  getRuntimeConfig?: () => OpenClawConfig;
  getScopedChannelsCommandSecretTargets?: typeof getScopedChannelsCommandSecretTargets;
  resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
  runMessageAction?: typeof runMessageAction;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
  messageActionTurnCapability?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  hasCurrentInboundAudio?: () => boolean;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sameChannelThreadRequired?: boolean;
  sandboxRoot?: string;
  requireExplicitTarget?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Process-local completion authority: send only to the current source route. */
  sourceReplyOnly?: boolean;
  inboundEventKind?: InboundEventKind;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
};

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const loadConfigForTool = options?.getRuntimeConfig ?? getRuntimeConfig;
  const getScopedSecretTargetsForTool =
    options?.getScopedChannelsCommandSecretTargets ?? getScopedChannelsCommandSecretTargets;
  const resolveSecretRefsForTool =
    options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
  const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
  let generatedIdempotencyCounter = 0;
  // Poll-vote echo record lives in the session-scoped map (recentPollVoteBySession)
  // so it survives the run boundary between the vote and the follow-up text; a
  // null session key disables the guard.
  const rawPollEchoSessionKey = options?.agentSessionKey?.trim() || undefined;
  const failedAutogeneratedIdempotencyKeys = new Map<string, string>();
  const effectiveCurrentChannel = resolveEffectiveCurrentChannelContext(options);
  const preparedMessageToolCatalog =
    options?.preparedMessageToolCatalog ?? getPreparedMessageToolCatalog();
  const explicitTargetToolCallIds = new WeakMap<object, string>();
  const currentThreadTs =
    options?.currentThreadTs ??
    (options?.agentThreadId != null
      ? stringifyRouteThreadId(options.agentThreadId)
      : effectiveCurrentChannel.currentThreadTs);
  const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : undefined);
  const agentAccountId =
    resolveAgentAccountId(options?.agentAccountId) ?? effectiveCurrentChannel.accountId;
  const currentChannelIsInternal =
    normalizeMessageChannel(effectiveCurrentChannel.currentChannelProvider) ===
    INTERNAL_MESSAGE_CHANNEL;
  // WebChat tool sends use the private sink without changing the run-level
  // contract: ordinary final answers must remain automatic and visible.
  const sourceReplySinkDeliveryMode = currentChannelIsInternal
    ? "message_tool_only"
    : options?.sourceReplyDeliveryMode;
  const resolvedAgentId =
    options?.agentId ??
    (options?.agentSessionKey
      ? resolveSessionAgentId({
          sessionKey: options.agentSessionKey,
          config: options?.config,
        })
      : undefined);
  const pollEchoSessionKey =
    rawPollEchoSessionKey && resolvedAgentId
      ? `${resolvedAgentId}\0${rawPollEchoSessionKey}`
      : undefined;
  const messageToolDiscoveryParams: MessageToolDiscoveryParams | undefined =
    options?.config && !options.sourceReplyOnly
      ? {
          cfg: options.config,
          currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
          currentChannelId: effectiveCurrentChannel.currentChannelId,
          currentThreadTs,
          currentMessageId: options.currentMessageId,
          currentAccountId: agentAccountId,
          sessionKey: options.agentSessionKey,
          sessionId: options.sessionId,
          agentId: resolvedAgentId,
          requesterSenderId: options.requesterSenderId,
          senderIsOwner: options.senderIsOwner,
          preparedMessageToolCatalog,
        }
      : undefined;
  const explicitMessageTargetContext: ExplicitMessageTargetContext | undefined =
    options?.requireExplicitTarget
      ? {
          currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
          preparedMessageToolCatalog,
        }
      : undefined;
  // Schema and prompt must use the same snapshot; repeated discovery can drift
  // across plugin hooks while needlessly loading channel action metadata twice.
  const actions = messageToolDiscoveryParams
    ? resolveMessageToolActionSchemaActions(messageToolDiscoveryParams)
    : undefined;
  const baseSchema = options?.sourceReplyOnly
    ? SOURCE_REPLY_ONLY_MESSAGE_SCHEMA
    : messageToolDiscoveryParams
      ? buildMessageToolSchema(messageToolDiscoveryParams, actions ?? [])
      : MessageToolSchema;
  const schema = addSourceReplyFinalControl(baseSchema, sourceReplySinkDeliveryMode);
  const description = options?.sourceReplyOnly
    ? appendMessageToolVisibleReplyHint(
        "Send a message to the current source conversation. Supports actions: send.",
        options.sourceReplyDeliveryMode,
        options.requireExplicitTarget,
      )
    : buildMessageToolDescription(
        actions,
        options?.sourceReplyDeliveryMode,
        options?.requireExplicitTarget,
      );

  return {
    label: "Message",
    name: "message",
    displaySummary: "Send and manage messages across configured channels.",
    description,
    parameters: schema,
    prepareBeforeToolCallParams: options?.requireExplicitTarget
      ? (params, context) => {
          if (params && typeof params === "object" && context.toolCallId) {
            explicitTargetToolCallIds.set(params, context.toolCallId);
          }
          return params;
        }
      : undefined,
    finalizeBeforeToolCallParams: options?.requireExplicitTarget
      ? (params, preparedParams) => {
          const actionParams = asToolParamsRecord(params);
          const actionId =
            preparedParams && typeof preparedParams === "object"
              ? explicitTargetToolCallIds.get(preparedParams)
              : undefined;
          const action = readToolStringParam(actionParams, "action");
          if (!actionId || !action) {
            requireExplicitMessageTarget(actionParams, explicitMessageTargetContext);
            return params;
          }
          createMessageToolDecisionRecorder({
            actionId,
            action,
            channel:
              normalizeMessageChannel(effectiveCurrentChannel.currentChannelProvider) ?? undefined,
          }).runBoundary(() =>
            requireExplicitMessageTarget(actionParams, explicitMessageTargetContext),
          );
          return params;
        }
      : undefined,
    execute: async (toolCallId, args, signal) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };
      const action = readToolStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      const decisionChannel =
        normalizeOptionalLowercaseString(params.channel) ??
        normalizeMessageChannel(effectiveCurrentChannel.currentChannelProvider) ??
        undefined;
      const decisions = createMessageToolDecisionRecorder({
        actionId: toolCallId,
        action,
        channel: decisionChannel,
      });
      const trustedTurnContext =
        resolvedAgentId && options?.agentSessionKey
          ? resolveMessageActionTurnCapability({
              token: options.messageActionTurnCapability,
              agentId: resolvedAgentId,
              runId: options.runId,
              sessionKey: options.agentSessionKey,
              sessionId: options.sessionId,
            })
          : undefined;
      if (normalizeOptionalString(options?.messageActionTurnCapability) && !trustedTurnContext) {
        decisions.recordTurnCapabilityInactive();
        throw new Error("message action turn capability is no longer active");
      }
      if (options?.sourceReplyOnly) {
        decisions.runBoundary(() =>
          enforceSourceReplyOnlyMessageAction({
            action,
            args: params,
            currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
            currentChannelId: effectiveCurrentChannel.currentChannelId,
            currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
            currentThreadTs,
            currentMessageId: options.currentMessageId,
            currentAccountId: agentAccountId,
            trustedTurnContext,
          }),
        );
      }
      // `final` is a Codex app-server-only source-delivery control. It must
      // not be dispatched to a provider or participate in idempotency.
      const requestedSourceReplyFinal =
        typeof params.final === "boolean" ? params.final : undefined;
      delete params.final;

      const suppressedVisiblePayloadReason = sanitizeMessageToolVisiblePayload(
        params,
        options?.agentSessionKey,
      );
      if (options?.sourceReplyOnly) {
        decisions.runBoundary(() => enforceSourceReplyOnlyTextDirectives(params));
      }

      if (
        suppressedVisiblePayloadReason &&
        action === "send" &&
        !hasSanitizedSendPayloadContent(params)
      ) {
        decisions.recordVisibleTextSuppressed(suppressedVisiblePayloadReason);
        return jsonResult({
          status: "suppressed",
          reason: suppressedVisiblePayloadReason,
          message:
            suppressedVisiblePayloadReason === "inbound_metadata_echo"
              ? "Suppressed outbound message text because it matched inbound runtime metadata."
              : "Suppressed outbound message text because it matched internal runtime context.",
        });
      }
      if (options?.requireExplicitTarget) {
        decisions.runBoundary(() =>
          requireExplicitMessageTarget(params, explicitMessageTargetContext);
        );
      }

      const gatewayOpts = readGatewayCallOptions(params);
      const rawConfig = options?.config ?? loadConfigForTool();
      const requestedAccountId = readToolStringParam(params, "accountId");
      decisions.runBoundary(() =>
        validateExplicitMessageAccountSelection({
          cfg: rawConfig,
          accountId: requestedAccountId,
          checkResolvedAccount: false,
        }),
      );
      const requestedBroadcastChannel = normalizeOptionalLowercaseString(params.channel);
      if (
        action === "broadcast" &&
        requestedBroadcastChannel &&
        requestedBroadcastChannel !== "all"
      ) {
        // Authorize and execute the same canonical provider. Otherwise an unavailable
        // hint can fall back to the current provider only after account authorization.
        const selection = await resolveMessageChannelSelection({
          cfg: rawConfig,
          channel: requestedBroadcastChannel,
          fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
        });
        params.channel = selection.channel;
      }
      const scope = resolveMessageSecretScope({
        channel: params.channel,
        target: params.target,
        targets: params.targets,
        fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
        accountId: requestedAccountId,
        fallbackAccountId: agentAccountId,
      });
      // Broadcast execution only narrows on an explicit non-all channel. Target
      // prefixes cannot authorize fewer providers than the runner will execute.
      const unscopedExplicitBroadcast =
        action === "broadcast" &&
        (!requestedBroadcastChannel || requestedBroadcastChannel === "all") &&
        requestedAccountId !== undefined;
      const explicitAccountId = decisions.runBoundary(() =>
        validateExplicitMessageAccountSelection({
          cfg: rawConfig,
          channel: unscopedExplicitBroadcast ? undefined : scope.channel,
          accountId: requestedAccountId,
          checkResolvedAccount: false,
        }),
      );
      const broadcastAccountPlan =
        unscopedExplicitBroadcast && explicitAccountId
          ? resolveMessageBroadcastAccountPlan({
              cfg: rawConfig,
              accountId: explicitAccountId,
            })
          : undefined;
      decisions.runBoundary(() =>
        enforceTrustedTurnExplicitAccount({
          explicitAccountId,
          selectedChannels: broadcastAccountPlan
            ? broadcastAccountPlan.candidateChannels
            : [scope.channel],
          trustedCurrentChannel: trustedTurnContext?.toolContext?.currentChannelProvider,
          trustedRequesterAccountId: trustedTurnContext?.requesterAccountId,
          hasTrustedTurnContext: trustedTurnContext !== undefined,
        }),
      );
      if (explicitAccountId) {
        scope.accountId = explicitAccountId;
        params.accountId = explicitAccountId;
      }
      const scopedTargets = getScopedSecretTargetsForTool({
        config: rawConfig,
        channel: broadcastAccountPlan ? undefined : scope.channel,
        ...(broadcastAccountPlan ? { channels: broadcastAccountPlan.secretChannels } : {}),
        accountId: scope.accountId,
      });
      const cfg = (
        await resolveSecretRefsForTool({
          config: rawConfig,
          commandName: "tools.message",
          targetIds: scopedTargets.targetIds,
          ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
          mode: "enforce_resolved",
        })
      ).resolvedConfig;

      const accountId = explicitAccountId ?? agentAccountId;
      const pollVoteEchoRoute = resolvePollVoteEchoRoute({
        action,
        args: params,
        channel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        accountId,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
      });
      const recentPollVote = pollEchoSessionKey
        ? recentPollVoteBySession.get(pollEchoSessionKey)
        : undefined;
      if (
        recentPollVote &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        (action === "send" || action === "reply")
      ) {
        if (Date.now() - recentPollVote.recordedAt > POLL_VOTE_ECHO_TTL_MS) {
          recentPollVoteBySession.delete(pollEchoSessionKey);
        } else if (pollVoteEchoRoute === recentPollVote.route) {
          const vote = recentPollVote;
          recentPollVoteBySession.delete(pollEchoSessionKey);
          const outboundText =
            readToolStringParam(params, "text") ??
            readToolStringParam(params, "message") ??
            readToolStringParam(params, "content");
          if (outboundText && isPollVoteEchoText(vote.option, outboundText)) {
            decisions.recordPollVoteEchoSuppressed();
            return jsonResult({
              status: "suppressed",
              reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
              message: "Suppressed outbound text because it only restated the poll vote just cast.",
            });
          }
        }
      }

      const gatewayResolved = resolveGatewayOptions(gatewayOpts);
      const { token: gatewayToken } = gatewayResolved;
      const callerOwnsTerminalReceipt =
        gatewayResolved.target === "remote" ||
        normalizeOptionalString(gatewayOpts.gatewayUrl) !== undefined ||
        normalizeOptionalString(gatewayOpts.gatewayToken) !== undefined;
      // Direct tool invocations already execute inside the authenticated
      // Gateway request. Keep their authority operation-local by dispatching
      // channel actions in-process instead of laundering it through a new
      // backend connection.
      const gateway: MessageActionGateway | undefined =
        options?.conversationReadOrigin === "direct-operator"
          ? undefined
          : {
              url: gatewayResolved.url,
              token: gatewayToken,
              timeoutMs: gatewayResolved.timeoutMs,
              clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
              clientDisplayName: "agent",
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              ...(callerOwnsTerminalReceipt
                ? { terminalSourceReplyReceiptOwner: "caller" as const }
                : {}),
              resolveAgentRuntimeIdentityToken: (context) =>
                resolveMessageActionAgentRuntimeIdentityToken({
                  opts: gatewayOpts,
                  target: gatewayResolved.target,
                  turnCapability: options?.messageActionTurnCapability,
                  turnCapabilitySessionKey: options?.agentSessionKey,
                  runId: options?.runId,
                  sessionId: options?.sessionId,
                  sourceReplyFinal: context?.sourceReplyFinal,
                  sourceReplyToolCallId: context?.sourceReplyToolCallId,
                  callerOwnsTerminalReceipt,
                }),
            };
      const hasCurrentMessageId =
        typeof options?.currentMessageId === "number" ||
        (typeof options?.currentMessageId === "string" &&
          options.currentMessageId.trim().length > 0);

      const toolContext =
        effectiveCurrentChannel.currentChannelId ||
        effectiveCurrentChannel.currentChatType ||
        effectiveCurrentChannel.currentChannelProvider ||
        effectiveCurrentChannel.currentMessagingTarget ||
        currentThreadTs ||
        hasCurrentMessageId ||
        replyToMode ||
        options?.hasRepliedRef ||
        options?.sameChannelThreadRequired
          ? {
              currentChannelId: effectiveCurrentChannel.currentChannelId,
              currentChatType: effectiveCurrentChannel.currentChatType,
              currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
              currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
              currentThreadTs,
              currentMessageId: options?.currentMessageId,
              replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              sameChannelThreadRequired: options?.sameChannelThreadRequired,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;
      let autogeneratedDeliveryFingerprint: string | undefined;
      let actionIdempotencyKey = normalizeOptionalString(params.idempotencyKey);
      if (!actionIdempotencyKey && options?.runId) {
        autogeneratedDeliveryFingerprint = buildMessageToolDeliveryFingerprint({ action, params });
        actionIdempotencyKey = failedAutogeneratedIdempotencyKeys.get(
          autogeneratedDeliveryFingerprint,
        );
        if (!actionIdempotencyKey) {
          const operationId =
            normalizeMessageToolIdempotencyKeyPart(toolCallId) ??
            String(++generatedIdempotencyCounter);
          actionIdempotencyKey = buildMessageToolAutogeneratedIdempotencyKey({
            runId: normalizeMessageToolIdempotencyKeyPart(options.runId) ?? options.runId,
            deliveryFingerprint: autogeneratedDeliveryFingerprint,
            operationId,
          });
        }
      }
      const actionParams = actionIdempotencyKey
        ? { ...params, idempotencyKey: actionIdempotencyKey }
        : params;
      const hasExactSourceTurn =
        action === "send" &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        normalizeOptionalString(trustedTurnContext?.toolContext?.currentSourceTurnId) !== undefined;
      let result: MessageActionResult;
      try {
        result = await runMessageActionForTool({
          cfg,
          action,
          params: actionParams,
          actionOrigin: "message-tool",
          defaultAccountId: accountId ?? undefined,
          requesterAccountId: trustedTurnContext?.requesterAccountId,
          requesterSenderId: trustedTurnContext?.requesterSenderId,
          messageActionAuthorization: {
            requesterAccountId: trustedTurnContext?.requesterAccountId,
            requesterSenderId: trustedTurnContext?.requesterSenderId,
            toolContext: trustedTurnContext?.toolContext,
          },
          senderIsOwner: options?.senderIsOwner,
          conversationReadOrigin: options?.conversationReadOrigin,
          broadcastAccountPlan,
          gateway,
          toolContext,
          sessionKey: options?.agentSessionKey,
          sourceReplySessionKey: options?.runSessionKey,
          sessionId: options?.sessionId,
          runId: options?.runId,
          agentId: resolvedAgentId,
          sandboxRoot: options?.sandboxRoot,
          sourceReplyDeliveryMode: sourceReplySinkDeliveryMode,
          // Only an admitted channel source can arm terminal restart reconciliation.
          // Source-less scheduled and ambient sends remain ordinary message actions.
          sourceReplyFinal: hasExactSourceTurn ? (requestedSourceReplyFinal ?? true) : undefined,
          sourceReplyToolCallId: hasExactSourceTurn ? toolCallId : undefined,
          inboundEventKind: options?.inboundEventKind,
          inboundAudio: options?.hasCurrentInboundAudio?.() ?? options?.currentInboundAudio,
          abortSignal: signal,
        });
      } catch (error) {
        if (autogeneratedDeliveryFingerprint && actionIdempotencyKey) {
          failedAutogeneratedIdempotencyKeys.set(
            autogeneratedDeliveryFingerprint,
            actionIdempotencyKey,
          );
        }
        decisions.recordTypedDenial(error);
        throw error;
      }
      if (
        autogeneratedDeliveryFingerprint &&
        failedAutogeneratedIdempotencyKeys.get(autogeneratedDeliveryFingerprint) ===
          actionIdempotencyKey
      ) {
        failedAutogeneratedIdempotencyKeys.delete(autogeneratedDeliveryFingerprint);
      }
      decisions.recordActionResult(result);
      const toolResult = getToolResult(result);
      const normalizationNotice = result.kind === "send" ? result.normalization?.notice : undefined;
      if (normalizationNotice) {
        const normalizedResult = toolResult ?? jsonResult(result.payload);
        return {
          ...normalizedResult,
          content: [...normalizedResult.content, { type: "text", text: normalizationNotice }],
        };
      }
      if (
        action === "poll-vote" &&
        pollVoteEchoRoute &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only"
      ) {
        const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
        const option =
          typeof details?.pollVotedOption === "string" ? details.pollVotedOption.trim() : "";
        if (option) {
          const recordedAt = Date.now();
          // Prune expired entries on write so a session that votes but never
          // sends a follow-up text can't leak a record forever in a long-lived
          // gateway; the map stays bounded to sessions that voted within the TTL.
          for (const [key, entry] of recentPollVoteBySession) {
            if (recordedAt - entry.recordedAt > POLL_VOTE_ECHO_TTL_MS) {
              recentPollVoteBySession.delete(key);
            }
          }
          recentPollVoteBySession.set(pollEchoSessionKey, {
            option,
            route: pollVoteEchoRoute,
            recordedAt,
          });
        }
      }
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
  };
}
