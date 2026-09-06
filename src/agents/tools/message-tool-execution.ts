import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { PreparedMessageToolCatalog } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as messageActionTurnCapability from "../../gateway/message-action-turn-capability.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveMessageBroadcastAccountPlan,
  validateExplicitMessageAccountSelection,
} from "../../infra/outbound/message-account-selection.js";
import type {
  MessageActionGateway,
  MessageActionResult,
} from "../../infra/outbound/message-action-contracts.js";
import { projectGatewayQueuedDeliveryResult } from "../../infra/outbound/message-action-execution.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  resolveEffectiveMessageToolsConfig,
  shouldApplyCrossContextMarker,
} from "../../infra/outbound/outbound-policy.js";
import { isDeliveredCurrentSourceReply } from "../../infra/outbound/source-reply-mirror.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPreparedMessageToolCatalog } from "../../plugins/prepared-message-tool-catalog.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import {
  attachEmbeddedMessageDeliveryFact,
  projectEmbeddedMessageDeliveryFact,
} from "../embedded-agent-message-delivery.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "./common.js";
import {
  readGatewayCallOptions,
  resolveGatewayOptions,
  resolveMessageActionAgentRuntimeIdentityToken,
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
import type { MessageToolOptions } from "./message-tool-execution-options.js";
import { createMessageToolExplicitTargetGuard } from "./message-tool-explicit-target.js";
import { deriveMessageToolIdempotency } from "./message-tool-idempotency.js";
import { resolveOutboundActionRoute } from "./message-tool-outbound-route.js";
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
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  releaseTurnSend,
  reserveTurnSend,
} from "./turn-send-ledger.js";

function resolveTrustedDecisionChannel(
  raw: string | null | undefined,
  catalog: PreparedMessageToolCatalog | undefined,
): string | undefined {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return undefined;
  }
  return channel === INTERNAL_MESSAGE_CHANNEL || catalog?.getChannel(channel) ? channel : undefined;
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

export type { MessageToolOptions } from "./message-tool-execution-options.js";

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
  // Agent-prefixed session slot shared with conversations_send so alternating the two
  // tools at one recipient shares one per-turn budget (buildTurnSendLedgerSessionKey).
  // Also scopes the poll-vote-echo map; a null session key disables both.
  const pollEchoSessionKey = buildTurnSendLedgerSessionKey(resolvedAgentId, rawPollEchoSessionKey);
  const messageToolDiscoveryParams: MessageToolDiscoveryParams | undefined =
    options?.config && !options.sourceReplyOnly
      ? {
          cfg: options.config,
          currentChatType: effectiveCurrentChannel.currentChatType,
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
  // Model-supplied channel text is untrusted until routing resolves it. Early
  // denials retain only the host-prepared source provider.
  const decisionChannel = resolveTrustedDecisionChannel(
    effectiveCurrentChannel.currentChannelProvider,
    preparedMessageToolCatalog,
  );
  const explicitTargetGuard = options?.requireExplicitTarget
    ? createMessageToolExplicitTargetGuard({
        currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
        preparedMessageToolCatalog,
        decisionChannel,
      })
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
  const sandboxRoot = options?.sandboxRoot?.trim();
  const sandboxWorkspaceMediaAccess =
    sandboxRoot && options?.sandboxFsBridge && options.sandboxWorkspaceMediaReadAllowed === true
      ? {
          localRoots: [
            sandboxRoot,
            ...(options?.sandboxContainerWorkdir ? [options.sandboxContainerWorkdir] : []),
          ],
          readFile: createSandboxBridgeReadFile({
            sandbox: { root: sandboxRoot, bridge: options.sandboxFsBridge },
          }),
          workspaceDir: sandboxRoot,
        }
      : undefined;

  return {
    label: "Message",
    name: "message",
    displaySummary: "Send and manage messages across configured channels.",
    description,
    parameters: schema,
    prepareBeforeToolCallParams: explicitTargetGuard?.prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams: explicitTargetGuard?.finalizeBeforeToolCallParams,
    execute: async (toolCallId, args, signal) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };
      const action = readToolStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      const decisions = createMessageToolDecisionRecorder({
        actionId: toolCallId,
        action,
        channel: decisionChannel,
      });
      const executionIdentityToken =
        !options?.runId || decisions.executionIdentityToken?.runId === options.runId
          ? decisions.executionIdentityToken
          : undefined;
      const deliveryRunId = options?.runId ?? executionIdentityToken?.runId;
      const trustedTurnContext =
        resolvedAgentId && options?.agentSessionKey
          ? messageActionTurnCapability.resolveMessageActionTurnCapability({
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
      if (explicitTargetGuard) {
        decisions.runBoundary(() => explicitTargetGuard.require(params, action));
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
      const outboundActionRoute = resolveOutboundActionRoute({
        action,
        args: params,
        channel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        accountId,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
      });
      // Per-turn send budget: the loop detector can't see reworded resends of the
      // same answer (it hashes full params), so count successful sends per
      // (turn, target) here and, from the second onward, nudge the model. This runs
      // independently of loopDetection.enabled — it is on by default. A resolved
      // context requires a single normalized target, a session key, and a run id;
      // broadcast fan-out and dry-runs are excluded.
      const budgetContext =
        shouldApplyCrossContextMarker(action) &&
        outboundActionRoute !== undefined &&
        pollEchoSessionKey !== undefined &&
        options?.runId !== undefined &&
        !params.dryRun
          ? {
              sessionKey: pollEchoSessionKey,
              runId: options.runId,
              targetKey: outboundActionRoute,
            }
          : undefined;
      const recentPollVote = pollEchoSessionKey
        ? recentPollVoteBySession.get(pollEchoSessionKey)
        : undefined;
      if (
        recentPollVote &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        (action === "send" || action === "reply")
      ) {
        if (Date.now() - recentPollVote.recordedAt >= POLL_VOTE_ECHO_TTL_MS) {
          recentPollVoteBySession.delete(pollEchoSessionKey);
        } else if (outboundActionRoute === recentPollVote.route) {
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

      // Derive the delivery idempotency key before the hard cap. A true replay (same
      // toolCallId + identical params) reproduces the same autogenerated key, which the
      // Gateway-backed delivery path dedups to the already-completed "sent" receipt
      // without re-delivering; the cap below uses this key to recognize and admit that
      // replay instead of blocking it. Derivation reads only values fixed above (params,
      // action, toolCallId, runId, and the closure-scoped failed-key map/counter), so
      // its position does not change the derived key.
      const { actionIdempotencyKey, autogeneratedDeliveryFingerprint } =
        deriveMessageToolIdempotency({
          action,
          params,
          explicitIdempotencyKey: params.idempotencyKey,
          runId: options?.runId,
          toolCallId,
          failedAutogeneratedKeys: failedAutogeneratedIdempotencyKeys,
          nextOperationId: () => String(++generatedIdempotencyCounter),
        });

      // Resolve the delivery route BEFORE reserving, because whether a repeated send is
      // re-delivery-safe depends on which delivery branch runMessageAction will take.
      // Direct tool invocations already execute inside the authenticated Gateway request,
      // so keep their authority operation-local by dispatching channel actions in-process
      // (gateway === undefined) instead of laundering it through a new backend connection.
      const gatewayResolved = resolveGatewayOptions(gatewayOpts);
      const { token: gatewayToken } = gatewayResolved;
      const callerOwnsTerminalReceipt =
        gatewayResolved.target === "remote" ||
        normalizeOptionalString(gatewayOpts.gatewayUrl) !== undefined ||
        normalizeOptionalString(gatewayOpts.gatewayToken) !== undefined;
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

      // Optional hard cap (opt-in, default off): reserve a slot before dispatch so a
      // concurrent same-target send cannot slip past the cap while this one is in
      // flight, then settle the reservation once delivery lands (commit) or does not
      // (release). Media (sendAttachment/upload-file) passes maxPerTurn=undefined so it
      // is never blocked — legitimately split attachments must not be truncated — while
      // still counting toward the nudge; broadcast fan-out never builds a budgetContext.
      // Cross-tool budget unification (message <-> conversations_send at one recipient)
      // is via the shared ledger slot key.
      //
      // Replay admission is route-aware. A committed operationId is handed to the ledger
      // ONLY when delivery actually relays through the Gateway backend, which resolves a
      // repeated idempotency key to the already-completed operation and returns it without
      // sending again. There the replay is admitted past the cap (`replay`) and left
      // unsettled, so a receipt the model already earned is neither suppressed nor
      // double-counted. A direct in-process send (message.ts sendDurableMessageBatchCore)
      // does NOT dedup on the idempotency key, so a repeat there is a genuine second
      // delivery; the operationId is withheld and the repeat is treated as an ordinary new
      // send — cap-blocked when a cap is set, honestly counted when it is not. The route is
      // read from the same gateway-vs-direct branch delivery itself selects (a live gateway
      // connection plus the channel's gateway execution/delivery mode), never from the
      // caller-supplied receipt owner or gateway target alone, which do not prove which
      // delivery branch runs.
      const isMediaSendAction = action === "sendAttachment" || action === "upload-file";
      const effectiveMessageTools = budgetContext
        ? resolveEffectiveMessageToolsConfig({ cfg: rawConfig, agentId: resolvedAgentId })
        : undefined;
      const maxPerTurn = isMediaSendAction
        ? undefined
        : effectiveMessageTools?.maxMessagesPerTurnPerTarget;
      const budgetDeliveryChannel = normalizeMessageChannel(
        scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
      );
      const budgetChannelPlugin =
        budgetContext && budgetDeliveryChannel
          ? getChannelPlugin(budgetDeliveryChannel)
          : undefined;
      const routeDedupsCompletedOperation =
        gateway !== undefined &&
        (budgetChannelPlugin?.actions?.resolveExecutionMode?.({ action }) === "gateway" ||
          budgetChannelPlugin?.outbound?.deliveryMode === "gateway");
      const reservation = budgetContext
        ? reserveTurnSend(budgetContext, {
            maxPerTurn,
            ...(actionIdempotencyKey && routeDedupsCompletedOperation
              ? { operationId: actionIdempotencyKey }
              : {}),
          })
        : undefined;
      if (reservation?.status === "exhausted") {
        return jsonResult({
          status: "suppressed",
          reason: "turn_send_budget_exhausted",
          message: `Blocked: already sent ${maxPerTurn} message(s) to this target this turn (maxMessagesPerTurnPerTarget). Finalize your reply instead of sending another message.`,
        });
      }
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
          ...messageActionTurnCapability.selectMessageActionRequesterIdentity(trustedTurnContext),
          messageActionAuthorization: {
            requesterAccountId: trustedTurnContext?.requesterAccountId,
            requesterSenderId: trustedTurnContext?.requesterSenderId,
            toolContext: trustedTurnContext?.toolContext,
          },
          senderIsOwner: options?.senderIsOwner,
          conversationReadOrigin: options?.conversationReadOrigin,
          workspaceDir: options?.workspaceDir,
          broadcastAccountPlan,
          gateway,
          toolContext,
          sessionKey: options?.agentSessionKey,
          sourceReplySessionKey: options?.runSessionKey,
          sessionId: options?.sessionId,
          runId: deliveryRunId,
          executionIdentityToken,
          agentId: resolvedAgentId,
          workspaceMediaAccess: sandboxWorkspaceMediaAccess,
          sandboxRoot: options?.sandboxRoot,
          sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
          sourceReplyDeliveryMode: sourceReplySinkDeliveryMode,
          // Only an admitted channel source can arm terminal restart reconciliation.
          // Source-less scheduled and ambient sends remain ordinary message actions.
          sourceReplyFinal: hasExactSourceTurn ? (requestedSourceReplyFinal ?? true) : undefined,
          sourceReplyToolCallId: hasExactSourceTurn ? toolCallId : undefined,
          onActionDenied: (error, channel, receiptDiscriminator) =>
            decisions.recordTypedDenial(
              error,
              resolveTrustedDecisionChannel(channel, preparedMessageToolCatalog),
              receiptDiscriminator,
            ),
          inboundEventKind: options?.inboundEventKind,
          inboundAudio: options?.hasCurrentInboundAudio?.() ?? options?.currentInboundAudio,
          abortSignal: signal,
        });
      } catch (error) {
        // Nothing reached the peer: roll back the reservation so a throwing send does
        // not consume the cap. A `replay` reservation took no pending slot (no-op).
        if (reservation?.status === "reserved") {
          releaseTurnSend(reservation.reservation);
        }
        if (autogeneratedDeliveryFingerprint && actionIdempotencyKey) {
          failedAutogeneratedIdempotencyKeys.set(
            autogeneratedDeliveryFingerprint,
            actionIdempotencyKey,
          );
        }
        // Queue-owned retry: the gateway already holds the durable row and
        // caches this outcome under the same idempotency key, so a model resend
        // of the same content collapses instead of minting a second send.
        const queuedDelivery = projectGatewayQueuedDeliveryResult(error);
        if (queuedDelivery) {
          return jsonResult(queuedDelivery);
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
      decisions.recordActionResult(
        result,
        resolveTrustedDecisionChannel(result.channel, preparedMessageToolCatalog),
      );
      const toolResult = getToolResult(result);
      // A2A enters through webchat but resolves an external source route here.
      // Compare the completed send with that route, independently of display mirrors.
      const currentSourceReply =
        result.handledBy !== "internal-source" &&
        isDeliveredCurrentSourceReply({
          action,
          cfg,
          channel: result.channel,
          actionParams: "to" in result ? { ...actionParams, target: result.to } : actionParams,
          accountId,
          currentAccountId: agentAccountId,
          sessionKey: options?.agentSessionKey,
          toolContext,
          deliveredPayload: result.payload,
          replyToIsExplicit: Boolean(readToolStringParam(actionParams, "replyTo")),
        });
      const messageDelivery = projectEmbeddedMessageDeliveryFact(result, currentSourceReply);
      if (
        messageDelivery?.status === "settled" &&
        !messageDelivery.partialDelivery &&
        requestedSourceReplyFinal !== false &&
        !result.dryRun &&
        currentSourceReply
      ) {
        messageDelivery.sourceReplyDelivered = true;
      }
      const normalizationNotice = result.kind === "send" ? result.normalization?.notice : undefined;
      if (
        action === "poll-vote" &&
        outboundActionRoute &&
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
            if (recordedAt - entry.recordedAt >= POLL_VOTE_ECHO_TTL_MS) {
              recentPollVoteBySession.delete(key);
            }
          }
          recentPollVoteBySession.set(pollEchoSessionKey, {
            option,
            route: outboundActionRoute,
            recordedAt,
          });
        }
      }
      // Reaching here without throwing means the action was dispatched. Settle the
      // reservation against the outcome: a delivery that landed commits (counting it in
      // the per-turn ledger regardless of the nudge toggle) and, from the second send to
      // this target onward, appends a one-line soft reminder unless turnSendNudge is
      // explicitly disabled. A `dry-run` result (e.g. no gateway) never counts.
      //
      // A core send can return deliveryStatus "suppressed" (e.g. no_visible_payload)
      // without reaching the peer; that must not consume the cap or fire a false
      // nudge, so it releases the reservation instead. Only "suppressed" is checked
      // because "failed"/"partial_failed" already throw upstream (message.ts) and never
      // reach here, and plugin/gateway sends carry kind:"send" with no sendResult
      // (deliveryStatus undefined) — those still count because delivery happened
      // remotely. A `replay` reservation is left unsettled (the Gateway deduped it to
      // the completed receipt), so it neither re-commits nor nudges.
      const deliveryStatus = result.kind === "send" ? result.sendResult?.deliveryStatus : undefined;
      const deliveredNothing = deliveryStatus === "suppressed" || deliveryStatus === "failed";
      let turnSendNotice: string | undefined;
      if (reservation?.status === "reserved") {
        const landed = result.kind !== "broadcast" && !result.dryRun && !deliveredNothing;
        if (!landed) {
          releaseTurnSend(reservation.reservation);
        } else {
          const sendCount = commitTurnSend(reservation.reservation);
          const nudgeEnabled = effectiveMessageTools?.turnSendNudge !== false;
          if (sendCount >= 2 && nudgeEnabled) {
            turnSendNotice = `You have already sent ${sendCount} messages to this target this turn; if this is a rewrite of the same reply, finalize now instead of sending another variant.`;
          }
        }
      }
      // Single append point for all three return exits so a notice is never dropped
      // or duplicated across the normalization/toolResult/payload paths.
      const baseResult = toolResult ?? jsonResult(result.payload);
      const appendedNotices = [normalizationNotice, turnSendNotice].filter(
        (notice): notice is string => Boolean(notice),
      );
      if (appendedNotices.length === 0) {
        return attachEmbeddedMessageDeliveryFact(baseResult, messageDelivery);
      }
      return attachEmbeddedMessageDeliveryFact(
        {
          ...baseResult,
          content: [
            ...baseResult.content,
            ...appendedNotices.map((text) => ({ type: "text" as const, text })),
          ],
        },
        messageDelivery,
      );
    },
  };
}
