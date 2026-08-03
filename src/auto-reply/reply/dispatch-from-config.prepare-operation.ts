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
import { shouldBypassPluginOwnedBindingForCommand } from "./dispatch-from-config.plugin-binding.js";
import type { PrepareDispatchOperationContextReadyState } from "./dispatch-from-config.prepare-context.js";
import {
  loadAbortRuntime,
  loadFastApproveRuntime,
} from "./dispatch-from-config.runtime-loaders.js";
import { extractShortModelName } from "./response-prefix-template.js";

export async function prepareDispatchOperation(state: PrepareDispatchOperationContextReadyState) {
  const {
    attachSourceReplyDeliveryMode,
    cfg,
    chatType,
    commitInboundDedupeIfClaimed,
    completeDispatchReplyOperation,
    ctx,
    deliverySuppressionReason,
    dispatcher,
    emitMessageReceivedHooks,
    finishReplyOperationAbortedDispatch,
    hookRunner,
    isPreDispatchOperationAborted,
    markIdle,
    params,
    persistPluginBindingUserTurn,
    pluginOwnedBinding,
    recordProcessed,
    sendBindingNotice,
    sessionAgentId,
    sessionKey,
    sessionStoreEntry,
    suppressDelivery,
  } = state;
  const abortRuntime = params.fastAbortResolver ? null : await loadAbortRuntime();
  const fastAbortResolver = params.fastAbortResolver ?? abortRuntime?.tryFastAbortFromMessage;
  const formatAbortReplyTextResolver =
    params.formatAbortReplyTextResolver ?? abortRuntime?.formatAbortReplyText;
  if (!fastAbortResolver || !formatAbortReplyTextResolver) {
    throw new Error("abort runtime unavailable");
  }
  const finishFastCommand = async (fast: {
    payload?: ReplyPayload;
    reason: "fast_abort" | "before_dispatch_handled";
    logKind: "fast_abort" | "fast_approve";
  }) => {
    if (pluginOwnedBinding) {
      touchConversationBindingRecord(pluginOwnedBinding.bindingId);
    }
    emitMessageReceivedHooks();
    let queuedFinal = false;
    let routedFinalCount = 0;
    if (!suppressDelivery && fast.payload) {
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
      // Routed delivery owns its destination-scoped prefix. Direct dispatchers already own
      // their prefix, so seed that live context only when no cross-channel route is used.
      const result = await state.routeReplyToOriginating(fast.payload, { responsePrefixContext });
      if (result) {
        queuedFinal = result.ok;
        if (state.isRoutedReplyDelivered(result)) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (${fast.logKind}) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        state.markInboundDedupeReplayUnsafe();
        params.replyOptions?.onModelSelected?.(modelSelection);
        queuedFinal = dispatcher.sendFinalReply(fast.payload);
      }
    } else if (suppressDelivery) {
      logVerbose(
        `dispatch-from-config: ${fast.logKind} reply suppressed by ${deliverySuppressionReason} (session=${sessionKey ?? "unknown"})`,
      );
    }
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed", { reason: fast.reason });
    markIdle("message_completed");
    commitInboundDedupeIfClaimed();
    completeDispatchReplyOperation();
    return {
      status: "complete" as const,
      result: attachSourceReplyDeliveryMode({ queuedFinal, counts }),
    };
  };
  const fastAbort = await fastAbortResolver({ ctx, cfg });
  if (fastAbort.handled) {
    return await finishFastCommand({
      payload: {
        text: formatAbortReplyTextResolver(
          fastAbort.stoppedSubagents,
          fastAbort.rejectionReason,
          fastAbort.failedSubagents,
        ),
      },
      reason: "fast_abort",
      logKind: "fast_abort",
    });
  }
  if (/^\s*\/approve(?:@[^\s]+)?(?:\s|$)/i.test(ctx.commandText)) {
    const fastApprove = await (
      await loadFastApproveRuntime()
    ).tryFastApproveFromMessage({
      ctx,
      cfg,
      agentId: sessionAgentId,
      sessionKey,
    });
    if (fastApprove.handled) {
      return await finishFastCommand({
        ...(fastApprove.reply ? { payload: fastApprove.reply } : {}),
        reason: "before_dispatch_handled",
        logKind: "fast_approve",
      });
    }
  }
  // Own the session before plugin-bound handlers or message hooks can perform
  // work. Fast abort, fast approval, and inbound dedupe remain ahead of this gate.
  const preDispatchAcquisition = await state.ensureDispatchReplyOperation("pre_dispatch");
  if (preDispatchAcquisition.status === "aborted") {
    return { status: "complete" as const, result: finishReplyOperationAbortedDispatch() };
  }
  if (preDispatchAcquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: state.finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
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
    } else if (
      state.sendPolicyDenied ||
      (suppressDelivery && !state.suppressAutomaticSourceDelivery)
    ) {
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
            await state.prepareHookMediaMetadata();
            if (isPreDispatchOperationAborted()) {
              throw new DispatchReplyOperationAbortedError();
            }
            const authorizedInboundClaimEvent = {
              ...state.hookState.inboundClaimEvent,
              senderIsOwner: bindingAuthorization.senderIsOwner,
            };
            return await state.runWithDispatchLifecycleAdmission(
              async () =>
                await hookRunner.runInboundClaimForPluginOutcome(
                  pluginOwnedBinding.pluginId,
                  authorizedInboundClaimEvent,
                  { ...state.hookState.inboundClaimContext, pluginBinding: pluginOwnedBinding },
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
          if (targetedClaimOutcome.result.reply && state.shouldDeliverPluginBindingReply) {
            // A bound plugin's reply is the explicit output for this claimed turn,
            // not an automatic agent final; message-tool-only suppression must not
            // turn normal user-request bindings into silent channel responses.
            // Ambient room events keep the same privacy guard as final replies.
            await state.deliverBindingPayload(
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
          state.bindingState.pluginFallbackReason =
            targetedClaimOutcome.status === "missing_plugin"
              ? "plugin-bound-fallback-missing-plugin"
              : "plugin-bound-fallback-no-handler";
          const isUnmentionedGroupFallback =
            (chatType === "group" || chatType === "channel") &&
            ctx.WasMentioned === false &&
            !state.explicitCommandTurnCtx;
          const shouldSuppressUnmentionedFallback =
            isUnmentionedGroupFallback && ctx.GroupRequireMention !== false;
          if (shouldSuppressUnmentionedFallback) {
            markIdle("plugin_binding_fallback_unmentioned");
            recordProcessed("completed", { reason: state.bindingState.pluginFallbackReason });
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
  return { status: "ready" as const, state };
}

type PrepareDispatchOperationResult = Awaited<ReturnType<typeof prepareDispatchOperation>>;
export type PrepareDispatchOperationReadyState = Extract<
  PrepareDispatchOperationResult,
  { status: "ready" }
>["state"];
