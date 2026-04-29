import crypto from "node:crypto";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  buildAgentRuntimeDeliveryPlan,
  buildAgentRuntimeOutcomePlan,
} from "../../agents/runtime-plan/build.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
  resolveModelFallbackOptions,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { refreshQueuedFollowupSession, type FollowupRun } from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedPiAgent>>;

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat: opts?.isHeartbeat === true,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (
    payloads: ReplyPayload[],
    queued: FollowupRun,
    resolvedRun: { provider: string; modelId: string },
  ) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;
    const deliveryPlan = buildAgentRuntimeDeliveryPlan({
      provider: resolvedRun.provider,
      modelId: resolvedRun.modelId,
      config: runtimeConfig,
      workspaceDir: queued.run.workspaceDir,
      agentDir: queued.run.agentDir,
    });

    const sendablePayloads = payloads.filter(
      (payload): payload is ReplyPayload =>
        hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload),
    );

    if (sendablePayloads.length === 0) {
      return;
    }

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      defaultRuntime.error?.(
        "followup queue: completed with payloads but no origin route or visible dispatcher is available",
      );
      return;
    }

    let crossChannelRouteFailureNeedsNotice = false;
    let routedAnyCrossChannelPayloadToOrigin = false;
    for (const payload of sendablePayloads) {
      const providerRoute = deliveryPlan.resolveFollowupRoute({
        payload,
        originatingChannel,
        originatingTo,
        originRoutable: Boolean(shouldRouteToOriginating),
        dispatcherAvailable: Boolean(opts?.onBlockReply),
      });
      if (providerRoute?.route === "drop") {
        logVerbose(
          `followup queue: provider hook dropped payload route reason=${providerRoute.reason ?? "unspecified"}`,
        );
        continue;
      }
      const deliveryRoute =
        providerRoute?.route === "origin" && shouldRouteToOriginating
          ? "origin"
          : providerRoute?.route === "dispatcher" && opts?.onBlockReply
            ? "dispatcher"
            : shouldRouteToOriginating
              ? "origin"
              : opts?.onBlockReply
                ? "dispatcher"
                : undefined;
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (deliveryRoute === "origin" && isRoutableChannel(originatingChannel) && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: queued.run.sessionKey,
          accountId: queued.originatingAccountId,
          requesterSenderId: queued.run.senderId,
          requesterSenderName: queued.run.senderName,
          requesterSenderUsername: queued.run.senderUsername,
          requesterSenderE164: queued.run.senderE164,
          threadId: queued.originatingThreadId,
          cfg: runtimeConfig,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (opts?.onBlockReply) {
            if (origin && origin === provider) {
              await opts.onBlockReply(payload);
            } else {
              crossChannelRouteFailureNeedsNotice = true;
            }
          } else {
            defaultRuntime.error?.(`followup queue: route-reply failed: ${errorMsg}`);
          }
        } else {
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (origin && provider && origin !== provider) {
            routedAnyCrossChannelPayloadToOrigin = true;
          }
        }
      } else if (deliveryRoute === "dispatcher" && opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
    if (
      crossChannelRouteFailureNeedsNotice &&
      !routedAnyCrossChannelPayloadToOrigin &&
      opts?.onBlockReply
    ) {
      await opts.onBlockReply({
        text:
          "Follow-up completed, but OpenClaw could not deliver it to the originating " +
          "channel. The reply content was not forwarded to this channel to avoid " +
          "cross-channel misdelivery.",
        isError: true,
      });
    }
  };

  return async (queued: FollowupRun) => {
    const queuedImages = queued.images ?? opts?.images;
    const queuedImageOrder = queued.imageOrder ?? opts?.imageOrder;
    queued.run.config = await resolveQueuedReplyExecutionConfig(queued.run.config, {
      originatingChannel: queued.originatingChannel,
      messageProvider: queued.run.messageProvider,
      originatingAccountId: queued.originatingAccountId,
      agentAccountId: queued.run.agentAccountId,
    });
    const replySessionKey = queued.run.sessionKey ?? sessionKey;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const effectiveQueued =
      runtimeConfig === queued.run.config
        ? queued
        : { ...queued, run: { ...queued.run, config: runtimeConfig } };
    const run = effectiveQueued.run;
    const replyOperation = createReplyOperation({
      sessionId: run.sessionId,
      sessionKey: replySessionKey ?? "",
      resetTriggered: false,
      upstreamAbortSignal: opts?.abortSignal,
    });
    try {
      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: run.messageProvider,
        }),
      );
      if (run.sessionKey) {
        registerAgentRunContext(runId, {
          sessionKey: run.sessionKey,
          verboseLevel: run.verboseLevel,
          isControlUiVisible: shouldSurfaceToControlUi,
        });
      }
      let autoCompactionCount = 0;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = run.provider;
      let fallbackModel = run.model;
      let activeSessionEntry =
        (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
      activeSessionEntry = await runPreflightCompactionIfNeeded({
        cfg: runtimeConfig,
        followupRun: effectiveQueued,
        promptForEstimate: queued.prompt,
        defaultModel,
        agentCfgContextTokens,
        sessionEntry: activeSessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isHeartbeat: opts?.isHeartbeat === true,
        replyOperation,
      });
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      replyOperation.setPhase("running");
      try {
        const outcomePlan = buildAgentRuntimeOutcomePlan();
        const fallbackResult = await runWithModelFallback<EmbeddedAgentRunResult>({
          ...resolveModelFallbackOptions(run, runtimeConfig),
          cfg: runtimeConfig,
          runId,
          classifyResult: ({ result, provider, model }) =>
            outcomePlan.classifyRunResult({ result, provider, model }),
          run: async (provider, model, runOptions) => {
            const authProfile = resolveRunAuthProfile(run, provider, { config: runtimeConfig });
            let attemptCompactionCount = 0;
            try {
              const result = await runEmbeddedPiAgent({
                allowGatewaySubagentBinding: true,
                replyOperation,
                sessionId: run.sessionId,
                sessionKey: run.sessionKey,
                agentId: run.agentId,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: run.messageProvider,
                agentAccountId: run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                groupId: run.groupId,
                groupChannel: run.groupChannel,
                groupSpace: run.groupSpace,
                senderId: run.senderId,
                senderName: run.senderName,
                senderUsername: run.senderUsername,
                senderE164: run.senderE164,
                senderIsOwner: run.senderIsOwner,
                sessionFile: run.sessionFile,
                agentDir: run.agentDir,
                workspaceDir: run.workspaceDir,
                config: runtimeConfig,
                skillsSnapshot: run.skillsSnapshot,
                prompt: queued.prompt,
                transcriptPrompt: queued.transcriptPrompt,
                extraSystemPrompt: run.extraSystemPrompt,
                silentReplyPromptMode: run.silentReplyPromptMode,
                sourceReplyDeliveryMode: run.sourceReplyDeliveryMode,
                ownerNumbers: run.ownerNumbers,
                enforceFinalTag: run.enforceFinalTag,
                allowEmptyAssistantReplyAsSilent: run.allowEmptyAssistantReplyAsSilent,
                provider,
                model,
                ...authProfile,
                thinkLevel: run.thinkLevel,
                verboseLevel: run.verboseLevel,
                reasoningLevel: run.reasoningLevel,
                suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
                execOverrides: run.execOverrides,
                bashElevated: run.bashElevated,
                timeoutMs: run.timeoutMs,
                runId,
                images: queuedImages,
                imageOrder: queuedImageOrder,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onAgentEvent: (evt) => {
                  if (evt.stream.startsWith("codex_app_server.")) {
                    emitAgentEvent({
                      runId,
                      stream: evt.stream,
                      data: evt.data,
                      ...(evt.sessionKey ? { sessionKey: evt.sessionKey } : {}),
                    });
                  }
                  if (evt.stream !== "compaction") {
                    return;
                  }
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const completed = evt.data?.completed === true;
                  if (phase === "end" && completed) {
                    attemptCompactionCount += 1;
                  }
                },
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
      } catch (err) {
        const message = formatErrorMessage(err);
        replyOperation.fail("run_failed", err);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
      }

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const providerUsed =
        runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? queued.run.provider;
      const contextTokensUsed =
        resolveContextTokensForModel({
          cfg: queued.run.config,
          provider: providerUsed,
          model: modelUsed,
          contextTokensOverride: agentCfgContextTokens,
          fallbackContextTokens: sessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS;

      if (storePath && sessionKey) {
        await persistRunSessionUsage({
          storePath,
          sessionKey,
          cfg: runtimeConfig,
          usage,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          promptTokens,
          modelUsed,
          providerUsed,
          contextTokensUsed,
          systemPromptReport: runResult.meta?.systemPromptReport,
          cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
          logLabel: "followup",
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) {
        return;
      }
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });
      const finalPayloads = resolveFollowupDeliveryPayloads({
        cfg: runtimeConfig,
        payloads: sanitizedPayloads,
        messageProvider: run.messageProvider,
        originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
        originatingChannel: queued.originatingChannel,
        originatingChatType: queued.originatingChatType,
        originatingTo: queued.originatingTo,
        sentMediaUrls: runResult.messagingToolSentMediaUrls,
        sentTargets: runResult.messagingToolSentTargets,
        sentTexts: runResult.messagingToolSentTexts,
      });

      if (finalPayloads.length === 0) {
        return;
      }

      if (autoCompactionCount > 0) {
        const previousSessionId = run.sessionId;
        const count = await incrementRunCompactionCount({
          cfg: runtimeConfig,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          amount: autoCompactionCount,
          compactionTokensAfter: runResult.meta?.agentMeta?.compactionTokensAfter,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          contextTokensUsed,
          newSessionId: runResult.meta?.agentMeta?.sessionId,
          newSessionFile: runResult.meta?.agentMeta?.sessionFile,
        });
        const refreshedSessionEntry =
          sessionKey && sessionStore ? sessionStore[sessionKey] : undefined;
        if (refreshedSessionEntry) {
          const queueKey = run.sessionKey ?? sessionKey;
          if (queueKey) {
            refreshQueuedFollowupSession({
              key: queueKey,
              previousSessionId,
              nextSessionId: refreshedSessionEntry.sessionId,
              nextSessionFile: refreshedSessionEntry.sessionFile,
            });
          }
        }
        if (run.verboseLevel && run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      if (run.sourceReplyDeliveryMode === "message_tool_only") {
        logVerbose(
          "followup queue: automatic source delivery suppressed by sourceReplyDeliveryMode: message_tool_only",
        );
        return;
      }

      await sendFollowupPayloads(finalPayloads, effectiveQueued, {
        provider: providerUsed,
        modelId: modelUsed,
      });
    } finally {
      replyOperation.complete();
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // buffered dispatcher's finally block, but followup turns bypass the
      // dispatcher entirely — so we must fire both signals here.  Without
      // this, NO_REPLY / empty-payload followups leave the typing indicator
      // stuck (the keepalive loop keeps sending "typing" to Telegram
      // indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
}
