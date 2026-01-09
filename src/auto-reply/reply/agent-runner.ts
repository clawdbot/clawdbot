import crypto from "node:crypto";
import fs from "node:fs";
import { runClaudeCliAgent } from "../../agents/claude-cli-runner.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  queueEmbeddedPiMessage,
  runEmbeddedPiAgent,
} from "../../agents/pi-embedded.js";
import { hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import {
  loadSessionStore,
  resolveSessionTranscriptPath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { extractAudioTag } from "./audio-tags.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  applyReplyTagsToPayload,
  applyReplyThreading,
  filterMessagingToolDuplicates,
  isRenderablePayload,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import {
  createReplyToModeFilterForChannel,
  resolveReplyToMode,
} from "./reply-threading.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";
import { createTypingSignaler } from "./typing-mode.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;
const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

const isBunFetchSocketError = (message?: string) =>
  Boolean(message && BUN_FETCH_SOCKET_ERROR_RE.test(message));

const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

const formatResponseUsageLine = (params: {
  usage?: NormalizedUsage;
  showCost: boolean;
  costConfig?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}): string | null => {
  const usage = params.usage;
  if (!usage) return null;
  const input = usage.input;
  const output = usage.output;
  if (typeof input !== "number" && typeof output !== "number") return null;
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel =
    typeof output === "number" ? formatTokenCount(output) : "?";
  const cost =
    params.showCost && typeof input === "number" && typeof output === "number"
      ? estimateUsageCost({
          usage: {
            input,
            output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          cost: params.costConfig,
        })
      : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${suffix}`;
};

const appendUsageLine = (
  payloads: ReplyPayload[],
  line: string,
): ReplyPayload[] => {
  let index = -1;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      index = i;
      break;
    }
  }
  if (index === -1) return [...payloads, { text: line }];
  const existing = payloads[index];
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = {
    ...existing,
    text: `${existingText}${separator}${line}`,
  };
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = () => {
    if (!sessionKey || !storePath) {
      return resolvedVerboseLevel === "on";
    }
    try {
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      const current = normalizeVerboseLevel(entry?.verboseLevel);
      if (current) return current === "on";
    } catch {
      // ignore store read failures
    }
    return resolvedVerboseLevel === "on";
  };

  const streamedPayloadKeys = new Set<string>();
  const pendingStreamedPayloadKeys = new Set<string>();
  const pendingBlockTasks = new Set<Promise<void>>();
  const pendingToolTasks = new Set<Promise<void>>();
  let blockReplyChain: Promise<void> = Promise.resolve();
  let blockReplyAborted = false;
  let didLogBlockReplyAbort = false;
  let didStreamBlockReply = false;
  const blockReplyTimeoutMs =
    opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
  const buildPayloadKey = (payload: ReplyPayload) => {
    const text = payload.text?.trim() ?? "";
    const mediaList = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    return JSON.stringify({
      text,
      mediaList,
      replyToId: payload.replyToId ?? null,
    });
  };
  const replyToChannel =
    sessionCtx.OriginatingChannel ??
    ((sessionCtx.Surface ?? sessionCtx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(
    replyToMode,
    replyToChannel,
  );
  const cfg = followupRun.run.config;

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(
      followupRun.run.sessionId,
      followupRun.prompt,
    );
    if (steered && !shouldFollowup) {
      if (sessionEntry && sessionStore && sessionKey) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await saveSessionStore(storePath, sessionStore);
        }
      }
      typing.cleanup();
      return undefined;
    }
  }

  if (isActive && (shouldFollowup || resolvedQueue.mode === "steer")) {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    typing.cleanup();
    return undefined;
  }

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  const finalizeWithFollowup = <T>(value: T): T => {
    scheduleFollowupDrain(queueKey, runFollowupTurn);
    return value;
  };

  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;
  let responseUsageLine: string | undefined;
  try {
    const runId = crypto.randomUUID();
    if (sessionKey) {
      registerAgentRunContext(runId, { sessionKey });
    }
    let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = followupRun.run.provider;
    let fallbackModel = followupRun.run.model;
    try {
      const allowPartialStream = !(
        followupRun.run.reasoningLevel === "stream" && opts?.onReasoningStream
      );
      const fallbackResult = await runWithModelFallback({
        cfg: followupRun.run.config,
        provider: followupRun.run.provider,
        model: followupRun.run.model,
        run: (provider, model) => {
          if (provider === "claude-cli") {
            const startedAt = Date.now();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: {
                phase: "start",
                startedAt,
              },
            });
            return runClaudeCliAgent({
              sessionId: followupRun.run.sessionId,
              sessionKey,
              sessionFile: followupRun.run.sessionFile,
              workspaceDir: followupRun.run.workspaceDir,
              config: followupRun.run.config,
              prompt: commandBody,
              provider,
              model,
              thinkLevel: followupRun.run.thinkLevel,
              timeoutMs: followupRun.run.timeoutMs,
              runId,
              extraSystemPrompt: followupRun.run.extraSystemPrompt,
              ownerNumbers: followupRun.run.ownerNumbers,
              claudeSessionId:
                sessionEntry?.claudeCliSessionId?.trim() || undefined,
            })
              .then((result) => {
                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "end",
                    startedAt,
                    endedAt: Date.now(),
                  },
                });
                return result;
              })
              .catch((err) => {
                emitAgentEvent({
                  runId,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: err instanceof Error ? err.message : String(err),
                  },
                });
                throw err;
              });
          }
          return runEmbeddedPiAgent({
            sessionId: followupRun.run.sessionId,
            sessionKey,
            messageProvider:
              sessionCtx.Provider?.trim().toLowerCase() || undefined,
            agentAccountId: sessionCtx.AccountId,
            sessionFile: followupRun.run.sessionFile,
            workspaceDir: followupRun.run.workspaceDir,
            agentDir: followupRun.run.agentDir,
            config: followupRun.run.config,
            skillsSnapshot: followupRun.run.skillsSnapshot,
            prompt: commandBody,
            extraSystemPrompt: followupRun.run.extraSystemPrompt,
            ownerNumbers: followupRun.run.ownerNumbers,
            enforceFinalTag: followupRun.run.enforceFinalTag,
            provider,
            model,
            authProfileId: followupRun.run.authProfileId,
            thinkLevel: followupRun.run.thinkLevel,
            verboseLevel: followupRun.run.verboseLevel,
            reasoningLevel: followupRun.run.reasoningLevel,
            bashElevated: followupRun.run.bashElevated,
            timeoutMs: followupRun.run.timeoutMs,
            runId,
            blockReplyBreak: resolvedBlockStreamingBreak,
            blockReplyChunking,
            onPartialReply:
              opts?.onPartialReply && allowPartialStream
                ? async (payload) => {
                    let text = payload.text;
                    if (!isHeartbeat && text?.includes("HEARTBEAT_OK")) {
                      const stripped = stripHeartbeatToken(text, {
                        mode: "message",
                      });
                      if (stripped.didStrip && !didLogHeartbeatStrip) {
                        didLogHeartbeatStrip = true;
                        logVerbose(
                          "Stripped stray HEARTBEAT_OK token from reply",
                        );
                      }
                      if (
                        stripped.shouldSkip &&
                        (payload.mediaUrls?.length ?? 0) === 0
                      ) {
                        return;
                      }
                      text = stripped.text;
                    }
                    await typingSignals.signalTextDelta(text);
                    await opts.onPartialReply?.({
                      text,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
            onReasoningStream:
              typingSignals.shouldStartOnReasoning || opts?.onReasoningStream
                ? async (payload) => {
                    await typingSignals.signalReasoningDelta();
                    await opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
            onAgentEvent: (evt) => {
              // Trigger typing when tools start executing
              if (evt.stream === "tool") {
                const phase =
                  typeof evt.data.phase === "string" ? evt.data.phase : "";
                if (phase === "start") {
                  void typingSignals.signalToolStart();
                }
              }
              // Track auto-compaction completion
              if (evt.stream === "compaction") {
                const phase =
                  typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              }
            },
            onBlockReply:
              blockStreamingEnabled && opts?.onBlockReply
                ? async (payload) => {
                    let text = payload.text;
                    if (!isHeartbeat && text?.includes("HEARTBEAT_OK")) {
                      const stripped = stripHeartbeatToken(text, {
                        mode: "message",
                      });
                      if (stripped.didStrip && !didLogHeartbeatStrip) {
                        didLogHeartbeatStrip = true;
                        logVerbose(
                          "Stripped stray HEARTBEAT_OK token from reply",
                        );
                      }
                      const hasMedia = (payload.mediaUrls?.length ?? 0) > 0;
                      if (stripped.shouldSkip && !hasMedia) return;
                      text = stripped.text;
                    }
                    const taggedPayload = applyReplyTagsToPayload(
                      {
                        text,
                        mediaUrls: payload.mediaUrls,
                        mediaUrl: payload.mediaUrls?.[0],
                      },
                      sessionCtx.MessageSid,
                    );
                    if (!isRenderablePayload(taggedPayload)) return;
                    const audioTagResult = extractAudioTag(taggedPayload.text);
                    const cleaned = audioTagResult.cleaned || undefined;
                    const hasMedia =
                      Boolean(taggedPayload.mediaUrl) ||
                      (taggedPayload.mediaUrls?.length ?? 0) > 0;
                    if (!cleaned && !hasMedia) return;
                    if (cleaned?.trim() === SILENT_REPLY_TOKEN && !hasMedia)
                      return;
                    const blockPayload: ReplyPayload = applyReplyToMode({
                      ...taggedPayload,
                      text: cleaned,
                      audioAsVoice: audioTagResult.audioAsVoice,
                    });
                    const payloadKey = buildPayloadKey(blockPayload);
                    if (
                      streamedPayloadKeys.has(payloadKey) ||
                      pendingStreamedPayloadKeys.has(payloadKey)
                    ) {
                      return;
                    }
                    if (blockReplyAborted) return;
                    pendingStreamedPayloadKeys.add(payloadKey);
                    void typingSignals
                      .signalTextDelta(taggedPayload.text)
                      .catch((err) => {
                        logVerbose(
                          `block reply typing signal failed: ${String(err)}`,
                        );
                      });
                    const timeoutError = new Error(
                      `block reply delivery timed out after ${blockReplyTimeoutMs}ms`,
                    );
                    const abortController = new AbortController();
                    blockReplyChain = blockReplyChain
                      .then(async () => {
                        if (blockReplyAborted) return false;
                        await withTimeout(
                          opts.onBlockReply?.(blockPayload, {
                            abortSignal: abortController.signal,
                            timeoutMs: blockReplyTimeoutMs,
                          }) ?? Promise.resolve(),
                          blockReplyTimeoutMs,
                          timeoutError,
                        );
                        return true;
                      })
                      .then((didSend) => {
                        if (!didSend) return;
                        streamedPayloadKeys.add(payloadKey);
                        didStreamBlockReply = true;
                      })
                      .catch((err) => {
                        if (err === timeoutError) {
                          abortController.abort();
                          blockReplyAborted = true;
                          if (!didLogBlockReplyAbort) {
                            didLogBlockReplyAbort = true;
                            logVerbose(
                              `block reply delivery timed out after ${blockReplyTimeoutMs}ms; skipping remaining block replies to preserve ordering`,
                            );
                          }
                          return;
                        }
                        logVerbose(
                          `block reply delivery failed: ${String(err)}`,
                        );
                      })
                      .finally(() => {
                        pendingStreamedPayloadKeys.delete(payloadKey);
                      });
                    const task = blockReplyChain;
                    pendingBlockTasks.add(task);
                    void task.finally(() => pendingBlockTasks.delete(task));
                  }
                : undefined,
            shouldEmitToolResult,
            onToolResult: opts?.onToolResult
              ? (payload) => {
                  // `subscribeEmbeddedPiSession` may invoke tool callbacks without awaiting them.
                  // If a tool callback starts typing after the run finalized, we can end up with
                  // a typing loop that never sees a matching markRunComplete(). Track and drain.
                  const task = (async () => {
                    let text = payload.text;
                    if (!isHeartbeat && text?.includes("HEARTBEAT_OK")) {
                      const stripped = stripHeartbeatToken(text, {
                        mode: "message",
                      });
                      if (stripped.didStrip && !didLogHeartbeatStrip) {
                        didLogHeartbeatStrip = true;
                        logVerbose(
                          "Stripped stray HEARTBEAT_OK token from reply",
                        );
                      }
                      if (
                        stripped.shouldSkip &&
                        (payload.mediaUrls?.length ?? 0) === 0
                      ) {
                        return;
                      }
                      text = stripped.text;
                    }
                    await typingSignals.signalTextDelta(text);
                    await opts.onToolResult?.({
                      text,
                      mediaUrls: payload.mediaUrls,
                    });
                  })()
                    .catch((err) => {
                      logVerbose(`tool result delivery failed: ${String(err)}`);
                    })
                    .finally(() => {
                      pendingToolTasks.delete(task);
                    });
                  pendingToolTasks.add(task);
                }
              : undefined,
          });
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isContextOverflow =
        /context.*overflow|too large|context window/i.test(message);
      const isSessionCorruption =
        /function call turn comes immediately after/i.test(message);

      // Auto-recover from Gemini session corruption by resetting the session
      if (isSessionCorruption && sessionKey && sessionStore && storePath) {
        const corruptedSessionId = sessionEntry?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath =
              resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Remove session entry from store
          delete sessionStore[sessionKey];
          await saveSessionStore(storePath, sessionStore);
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${sessionKey}: ${String(cleanupErr)}`,
          );
        }

        return finalizeWithFollowup({
          text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
        });
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      return finalizeWithFollowup({
        text: isContextOverflow
          ? "⚠️ Context overflow - conversation too long. Starting fresh might help!"
          : `⚠️ Agent failed before reply: ${message}. Check gateway logs for details.`,
      });
    }

    if (
      shouldInjectGroupIntro &&
      sessionEntry &&
      sessionStore &&
      sessionKey &&
      sessionEntry.groupActivationNeedsSystemIntro
    ) {
      sessionEntry.groupActivationNeedsSystemIntro = false;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }

    const payloadArray = runResult.payloads ?? [];
    if (pendingBlockTasks.size > 0) {
      await Promise.allSettled(pendingBlockTasks);
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }
    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) return finalizeWithFollowup(undefined);

    const sanitizedPayloads = isHeartbeat
      ? payloadArray
      : payloadArray.flatMap((payload) => {
          let text = payload.text;

          if (payload.isError && text && isBunFetchSocketError(text)) {
            text = formatBunFetchSocketError(text);
          }

          if (!text || !text.includes("HEARTBEAT_OK"))
            return [{ ...payload, text }];
          const stripped = stripHeartbeatToken(text, { mode: "message" });
          if (stripped.didStrip && !didLogHeartbeatStrip) {
            didLogHeartbeatStrip = true;
            logVerbose("Stripped stray HEARTBEAT_OK token from reply");
          }
          const hasMedia =
            Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          if (stripped.shouldSkip && !hasMedia) return [];
          return [{ ...payload, text: stripped.text }];
        });

    const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
      payloads: sanitizedPayloads,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSid,
    })
      .map((payload) => {
        const audioTagResult = extractAudioTag(payload.text);
        return {
          ...payload,
          text: audioTagResult.cleaned ? audioTagResult.cleaned : undefined,
          audioAsVoice: audioTagResult.audioAsVoice,
        };
      })
      .filter(isRenderablePayload);

    // Drop final payloads only when block streaming succeeded end-to-end.
    // If streaming aborted (e.g., timeout), fall back to final payloads.
    const shouldDropFinalPayloads =
      blockStreamingEnabled && didStreamBlockReply && !blockReplyAborted;
    const messagingToolSentTexts = runResult.messagingToolSentTexts ?? [];
    const messagingToolSentTargets = runResult.messagingToolSentTargets ?? [];
    const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTargets,
      originatingTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
      accountId: sessionCtx.AccountId,
    });
    const dedupedPayloads = filterMessagingToolDuplicates({
      payloads: replyTaggedPayloads,
      sentTexts: messagingToolSentTexts,
    });
    const filteredPayloads = shouldDropFinalPayloads
      ? []
      : blockStreamingEnabled
        ? dedupedPayloads.filter(
            (payload) => !streamedPayloadKeys.has(buildPayloadKey(payload)),
          )
        : dedupedPayloads;
    const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

    if (replyPayloads.length === 0) return finalizeWithFollowup(undefined);

    const shouldSignalTyping = replyPayloads.some((payload) => {
      const trimmed = payload.text?.trim();
      if (trimmed && trimmed !== SILENT_REPLY_TOKEN) return true;
      if (payload.mediaUrl) return true;
      if (payload.mediaUrls && payload.mediaUrls.length > 0) return true;
      return false;
    });
    if (shouldSignalTyping) {
      await typingSignals.signalRunStart();
    }

    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed =
      runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta.agentMeta?.provider ??
      fallbackProvider ??
      followupRun.run.provider;
    const cliSessionId =
      providerUsed === "claude-cli"
        ? runResult.meta.agentMeta?.sessionId?.trim()
        : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      sessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    if (sessionStore && sessionKey) {
      if (hasNonzeroUsage(usage)) {
        const entry = sessionEntry ?? sessionStore[sessionKey];
        if (entry) {
          const input = usage.input ?? 0;
          const output = usage.output ?? 0;
          const promptTokens =
            input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          const nextEntry = {
            ...entry,
            inputTokens: input,
            outputTokens: output,
            totalTokens:
              promptTokens > 0 ? promptTokens : (usage.total ?? input),
            modelProvider: providerUsed,
            model: modelUsed,
            contextTokens: contextTokensUsed ?? entry.contextTokens,
            updatedAt: Date.now(),
          };
          if (cliSessionId) {
            nextEntry.claudeCliSessionId = cliSessionId;
          }
          sessionStore[sessionKey] = nextEntry;
          if (storePath) {
            await saveSessionStore(storePath, sessionStore);
          }
        }
      } else if (modelUsed || contextTokensUsed) {
        const entry = sessionEntry ?? sessionStore[sessionKey];
        if (entry) {
          sessionStore[sessionKey] = {
            ...entry,
            modelProvider: providerUsed ?? entry.modelProvider,
            model: modelUsed ?? entry.model,
            contextTokens: contextTokensUsed ?? entry.contextTokens,
            claudeCliSessionId: cliSessionId ?? entry.claudeCliSessionId,
          };
          if (storePath) {
            await saveSessionStore(storePath, sessionStore);
          }
        }
      }
    }

    const responseUsageEnabled =
      (sessionEntry?.responseUsage ??
        (sessionKey
          ? sessionStore?.[sessionKey]?.responseUsage
          : undefined)) === "on";
    if (responseUsageEnabled && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      const formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted) responseUsageLine = formatted;
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = replyPayloads;
    if (autoCompactionCompleted) {
      const count = await incrementCompactionCount({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
      if (resolvedVerboseLevel === "on") {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        finalPayloads = [
          { text: `🧹 Auto-compaction complete${suffix}.` },
          ...finalPayloads,
        ];
      }
    }
    if (resolvedVerboseLevel === "on" && isNewSession) {
      finalPayloads = [
        { text: `🧭 New session: ${followupRun.run.sessionId}` },
        ...finalPayloads,
      ];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
    );
  } finally {
    typing.markRunComplete();
  }
}
