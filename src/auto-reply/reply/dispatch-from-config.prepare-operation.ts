import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { touchConversationBindingRecord } from "../../bindings/records.js";
import { logVerbose } from "../../globals.js";
import {
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingUnavailableText,
  hasShownPluginBindingFallbackNotice,
  markPluginBindingFallbackNoticeShown,
} from "../../plugins/conversation-binding.js";
import { getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { ReplyPayload } from "../reply-payload.js";
import { DispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import { extendPreparedDispatchState } from "./dispatch-from-config.phase-state.js";
import { shouldBypassPluginOwnedBindingForCommand } from "./dispatch-from-config.plugin-binding.js";
import type { PrepareDispatchOperationContextReadyState } from "./dispatch-from-config.prepare-context.js";
import { loadAbortRuntime } from "./dispatch-from-config.runtime-loaders.js";
import { extractShortModelName } from "./response-prefix-template.js";

export async function prepareDispatchOperation(state: PrepareDispatchOperationContextReadyState) {
  const {
    attachSourceReplyDeliveryMode,
    cfg,
    chatType,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliverBindingPayload,
    deliverySuppressionReason,
    dispatcher,
    emitMessageReceivedHooks,
    ensureDispatchReplyOperation,
    explicitCommandTurnCtx,
    finishReplyOperationAbortedDispatch,
    finishReplyOperationBusyDispatch,
    hookRunner,
    isPreDispatchOperationAborted,
    isRoutedReplyDelivered,
    markIdle,
    markInboundDedupeReplayUnsafe,
    params,
    persistPluginBindingUserTurn,
    pluginOwnedBinding,
    prepareHookMediaMetadata,
    recordProcessed,
    routeReplyToOriginating,
    runWithDispatchLifecycleAdmission,
    sendBindingNotice,
    sendPolicyDenied,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    shouldDeliverPluginBindingReply,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
  } = state;
  const abortRuntime = params.fastAbortResolver ? null : await loadAbortRuntime();
  const fastAbortResolver = params.fastAbortResolver ?? abortRuntime?.tryFastAbortFromMessage;
  const formatAbortReplyTextResolver =
    params.formatAbortReplyTextResolver ?? abortRuntime?.formatAbortReplyText;
  if (!fastAbortResolver || !formatAbortReplyTextResolver) {
    throw new Error("abort runtime unavailable");
  }
  const fastAbort = await fastAbortResolver({ ctx, cfg });
  if (fastAbort.handled) {
    if (pluginOwnedBinding) {
      touchConversationBindingRecord(pluginOwnedBinding.bindingId);
    }
    emitMessageReceivedHooks();
    let queuedFinal = false;
    let routedFinalCount = 0;
    if (!suppressDelivery) {
      const selectedModel = resolveSessionModelRef(cfg, sessionStoreEntry.entry, sessionAgentId);
      const modelSelection = {
        ...selectedModel,
        thinkLevel: sessionStoreEntry.entry?.thinkingLevel,
      };
      const responsePrefixContext = {
        identityName: normalizeOptionalString(resolveAgentIdentity(cfg, sessionAgentId)?.name),
        provider: selectedModel.provider,
        model: extractShortModelName(selectedModel.model),
        modelFull: `${selectedModel.provider}/${selectedModel.model}`,
        thinkingLevel: modelSelection.thinkLevel ?? "off",
      };
      const payload = {
        text: formatAbortReplyTextResolver(fastAbort.stoppedSubagents, fastAbort.rejectionReason),
      } satisfies ReplyPayload;
      // Routed delivery owns its destination-scoped prefix. Direct dispatchers already own
      // their prefix, so seed that live context only when no cross-channel route is used.
      const result = await routeReplyToOriginating(payload, { responsePrefixContext });
      if (result) {
        queuedFinal = result.ok;
        if (isRoutedReplyDelivered(result)) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        markInboundDedupeReplayUnsafe();
        params.replyOptions?.onModelSelected?.(modelSelection);
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
    } else {
      logVerbose(
        `dispatch-from-config: fast_abort reply suppressed by ${deliverySuppressionReason} (session=${sessionKey ?? "unknown"})`,
      );
    }
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed", { reason: "fast_abort" });
    markIdle("message_completed");
    commitInboundDedupeIfClaimed();
    completeDispatchReplyOperation();
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({ queuedFinal, counts }),
    };
  }
  // Own the session before plugin-bound handlers or message hooks can perform
  // work. Fast abort and inbound dedupe intentionally remain ahead of this gate.
  const preDispatchAcquisition = await ensureDispatchReplyOperation("pre_dispatch");
  if (preDispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
  }
  if (preDispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
    };
  }

  if (pluginOwnedBinding) {
    if (isPreDispatchOperationAborted()) {
      return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
    }
    touchConversationBindingRecord(pluginOwnedBinding.bindingId);
    if (shouldBypassPluginOwnedBindingForCommand(ctx, cfg)) {
      logVerbose(
        `plugin-bound inbound command escaped plugin binding (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to command processing`,
      );
    } else if (sendPolicyDenied || (suppressDelivery && !suppressAutomaticSourceDelivery)) {
      // Plugin-bound inbound handlers typically emit outbound replies we
      // cannot rewind. When automatic delivery is explicitly denied, skip the
      // plugin claim and fall through to normal suppressed agent processing.
      // message_tool_only is the normal visible-reply mode for group chats and
      // must still let the bound plugin own the turn unless sendPolicy denied it.
      logVerbose(
        `plugin-bound inbound skipped under ${deliverySuppressionReason} (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to suppressed agent processing`,
      );
    } else {
      logVerbose(
        `plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`,
      );
      // Bound native runtimes need the current owner decision, not stale bind-time identity.
      // The resolver folds internal operator.admin authority into this owner decision.
      const bindingAuthorization = resolveCommandAuthorization({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized,
      });
      const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
        ? await (async () => {
            await prepareHookMediaMetadata();
            if (isPreDispatchOperationAborted()) {
              throw new DispatchReplyOperationAbortedError();
            }
            const authorizedInboundClaimEvent = {
              ...state.inboundClaimEvent,
              senderIsOwner: bindingAuthorization.senderIsOwner,
            };
            return await runWithDispatchLifecycleAdmission(
              async () =>
                await hookRunner.runInboundClaimForPluginOutcome(
                  pluginOwnedBinding.pluginId,
                  authorizedInboundClaimEvent,
                  { ...state.inboundClaimContext, pluginBinding: pluginOwnedBinding },
                ),
            );
          })()
        : (() => {
            const pluginLoaded =
              getGlobalPluginRegistry()?.plugins.some(
                (plugin) => plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded",
              ) ?? false;
            return pluginLoaded
              ? ({ status: "no_handler" } as const)
              : ({ status: "missing_plugin" } as const);
          })();
      if (isPreDispatchOperationAborted()) {
        return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
      }

      switch (targetedClaimOutcome.status) {
        case "handled": {
          const transcriptOwner = await persistPluginBindingUserTurn();
          if (targetedClaimOutcome.result.reply && shouldDeliverPluginBindingReply) {
            // A bound plugin's reply is the explicit output for this claimed turn,
            // not an automatic agent final; message-tool-only suppression must not
            // turn normal user-request bindings into silent channel responses.
            // Ambient room events keep the same privacy guard as final replies.
            await deliverBindingPayload(
              targetedClaimOutcome.result.reply,
              "terminal",
              transcriptOwner,
            );
          }
          markIdle("plugin_binding_dispatch");
          recordProcessed("completed", { reason: "plugin-bound-handled" });
          commitInboundDedupeIfClaimed();
          completeDispatchReplyOperation();
          return {
            status: "complete" as const,
            result: attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            }),
          };
        }
        case "missing_plugin":
        case "no_handler": {
          state.pluginFallbackReason =
            targetedClaimOutcome.status === "missing_plugin"
              ? "plugin-bound-fallback-missing-plugin"
              : "plugin-bound-fallback-no-handler";
          const isUnmentionedGroupFallback =
            (chatType === "group" || chatType === "channel") &&
            ctx.WasMentioned === false &&
            !explicitCommandTurnCtx;
          const shouldSuppressUnmentionedFallback =
            isUnmentionedGroupFallback && ctx.GroupRequireMention !== false;
          if (shouldSuppressUnmentionedFallback) {
            markIdle("plugin_binding_fallback_unmentioned");
            recordProcessed("completed", { reason: state.pluginFallbackReason });
            commitInboundDedupeIfClaimed();
            completeDispatchReplyOperation();
            return {
              status: "complete" as const,
              result: attachSourceReplyDeliveryMode({
                queuedFinal: false,
                counts: dispatcher.getQueuedCounts(),
              }),
            };
          }
          if (!hasShownPluginBindingFallbackNotice(pluginOwnedBinding.bindingId)) {
            const didSendNotice = await sendBindingNotice(
              { text: buildPluginBindingUnavailableText(pluginOwnedBinding) },
              "additive",
            );
            if (didSendNotice) {
              markPluginBindingFallbackNoticeShown(pluginOwnedBinding.bindingId);
            }
          }
          break;
        }
        case "declined": {
          const transcriptOwner = await persistPluginBindingUserTurn();
          await sendBindingNotice(
            { text: buildPluginBindingDeclinedText(pluginOwnedBinding) },
            "terminal",
            transcriptOwner,
          );
          markIdle("plugin_binding_declined");
          recordProcessed("completed", { reason: "plugin-bound-declined" });
          commitInboundDedupeIfClaimed();
          completeDispatchReplyOperation();
          return {
            status: "complete" as const,
            result: attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            }),
          };
        }
        case "error": {
          const transcriptOwner = await persistPluginBindingUserTurn();
          logVerbose(
            `plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`,
          );
          await sendBindingNotice(
            { text: buildPluginBindingErrorText(pluginOwnedBinding) },
            "terminal",
            transcriptOwner,
          );
          markIdle("plugin_binding_error");
          recordProcessed("completed", { reason: "plugin-bound-error" });
          commitInboundDedupeIfClaimed();
          completeDispatchReplyOperation();
          return {
            status: "complete" as const,
            result: attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            }),
          };
        }
      }
    }
  }

  emitMessageReceivedHooks();
  const nextState = extendPreparedDispatchState(state, {}, {});
  return { status: "ready" as const, state: nextState };
}

type PrepareDispatchOperationResult = Awaited<ReturnType<typeof prepareDispatchOperation>>;
export type PrepareDispatchOperationReadyState = Extract<
  PrepareDispatchOperationResult,
  { status: "ready" }
>["state"];
