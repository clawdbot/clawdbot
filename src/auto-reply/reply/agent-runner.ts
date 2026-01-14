import crypto from "node:crypto";
import fs from "node:fs";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  queueEmbeddedPiMessage,
  runEmbeddedPiAgent,
} from "../../agents/pi-embedded.js";
import {
  isCompactionFailureError,
  isContextOverflowError,
} from "../../agents/pi-embedded-helpers.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxRuntimeStatus,
} from "../../agents/sandbox.js";
import { hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import { getChannelDock } from "../../channels/dock.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import { normalizeChannelId } from "../../channels/registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  saveSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { isAudioFileName } from "../../media/mime.js";
import { defaultRuntime } from "../../runtime.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createAudioAsVoiceBuffer,
  createBlockReplyPipeline,
} from "./block-reply-pipeline.js";
import { resolveBlockStreamingCoalescing } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
  scheduleFollowupDrain,
} from "./queue.js";
import { parseReplyDirectives } from "./reply-directives.js";
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

/**
 * Build provider-specific threading context for tool auto-injection.
 */
function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: ClawdbotConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  if (!config) return {};
  const provider = normalizeChannelId(sessionCtx.Provider);
  if (!provider) return {};
  const dock = getChannelDock(provider);
  if (!dock?.threading?.buildToolContext) return {};
  return (
    dock.threading.buildToolContext({
      cfg: config,
      accountId: sessionCtx.AccountId,
      context: {
        Channel: sessionCtx.Provider,
        To: sessionCtx.To,
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
      },
      hasRepliedRef,
    }) ?? {}
  );
}

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

const resolveEnforceFinalTag = (run: FollowupRun["run"], provider: string) =>
  Boolean(run.enforceFinalTag || isReasoningTagProvider(provider));

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

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

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

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs =
    opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const hasAudioMedia = (urls?: string[]): boolean =>
    Boolean(urls?.some((u) => isAudioFileName(u)));
  const isAudioPayload = (payload: ReplyPayload) =>
    hasAudioMedia(
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
    );
  const replyToChannel =
    sessionCtx.OriginatingChannel ??
    ((sessionCtx.Surface ?? sessionCtx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(
    replyToMode,
    replyToChannel,
  );
  const cfg = followupRun.run.config;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveBlockStreamingCoalescing(
          cfg,
          sessionCtx.Provider,
          sessionCtx.AccountId,
          blockReplyChunking,
        )
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(
      followupRun.run.sessionId,
      followupRun.prompt,
    );
    if (steered && !shouldFollowup) {
      if (activeSessionEntry && activeSessionStore && sessionKey) {
        activeSessionEntry.updatedAt = Date.now();
        activeSessionStore[sessionKey] = activeSessionEntry;
        if (storePath) {
          await saveSessionStore(storePath, activeSessionStore);
        }
      }
      typing.cleanup();
      return undefined;
    }
  }

  if (isActive && (shouldFollowup || resolvedQueue.mode === "steer")) {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    if (activeSessionEntry && activeSessionStore && sessionKey) {
      activeSessionEntry.updatedAt = Date.now();
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, activeSessionStore);
      }
    }
    typing.cleanup();
    return undefined;
  }

  const memoryFlushSettings = resolveMemoryFlushSettings(cfg);
  const memoryFlushWritable = (() => {
    if (!sessionKey) return true;
    const runtime = resolveSandboxRuntimeStatus({ cfg, sessionKey });
    if (!runtime.sandboxed) return true;
    const sandboxCfg = resolveSandboxConfigForAgent(cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();
  const shouldFlushMemory =
    memoryFlushSettings &&
    memoryFlushWritable &&
    !isHeartbeat &&
    !isCliProvider(followupRun.run.provider, cfg) &&
    shouldRunMemoryFlush({
      entry:
        activeSessionEntry ??
        (sessionKey ? activeSessionStore?.[sessionKey] : undefined),
      contextWindowTokens: resolveMemoryFlushContextWindowTokens({
        modelId: followupRun.run.model ?? defaultModel,
        agentCfgContextTokens,
      }),
      reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
      softThresholdTokens: memoryFlushSettings.softThresholdTokens,
    });
  if (shouldFlushMemory) {
    const flushRunId = crypto.randomUUID();
    if (sessionKey) {
      registerAgentRunContext(flushRunId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }
    let memoryCompactionCompleted = false;
    const flushSystemPrompt = [
      followupRun.run.extraSystemPrompt,
      memoryFlushSettings.systemPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await runWithModelFallback({
        cfg: followupRun.run.config,
        provider: followupRun.run.provider,
        model: followupRun.run.model,
        fallbacksOverride: resolveAgentModelFallbacksOverride(
          followupRun.run.config,
          resolveAgentIdFromSessionKey(followupRun.run.sessionKey),
        ),
        run: (provider, model) =>
          runEmbeddedPiAgent({
            sessionId: followupRun.run.sessionId,
            sessionKey,
            messageProvider:
              sessionCtx.Provider?.trim().toLowerCase() || undefined,
            agentAccountId: sessionCtx.AccountId,
            // Provider threading context for tool auto-injection
            ...buildThreadingToolContext({
              sessionCtx,
              config: followupRun.run.config,
              hasRepliedRef: opts?.hasRepliedRef,
            }),
            sessionFile: followupRun.run.sessionFile,
            workspaceDir: followupRun.run.workspaceDir,
            agentDir: followupRun.run.agentDir,
            config: followupRun.run.config,
            skillsSnapshot: followupRun.run.skillsSnapshot,
            prompt: memoryFlushSettings.prompt,
            extraSystemPrompt: flushSystemPrompt,
            ownerNumbers: followupRun.run.ownerNumbers,
            enforceFinalTag: resolveEnforceFinalTag(followupRun.run, provider),
            provider,
            model,
            authProfileId: followupRun.run.authProfileId,
            thinkLevel: followupRun.run.thinkLevel,
            verboseLevel: followupRun.run.verboseLevel,
            reasoningLevel: followupRun.run.reasoningLevel,
            bashElevated: followupRun.run.bashElevated,
            timeoutMs: followupRun.run.timeoutMs,
            runId: flushRunId,
            onAgentEvent: (evt) => {
              if (evt.stream === "compaction") {
                const phase =
                  typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  memoryCompactionCompleted = true;
                }
              }
            },
          }),
      });
      let memoryFlushCompactionCount =
        activeSessionEntry?.compactionCount ??
        (sessionKey ? activeSessionStore?.[sessionKey]?.compactionCount : 0) ??
        0;
      if (memoryCompactionCompleted) {
        const nextCount = await incrementCompactionCount({
          sessionEntry: activeSessionEntry,
          sessionStore: activeSessionStore,
          sessionKey,
          storePath,
        });
        if (typeof nextCount === "number") {
          memoryFlushCompactionCount = nextCount;
        }
      }
      if (storePath && sessionKey) {
        try {
          const updatedEntry = await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async () => ({
              memoryFlushAt: Date.now(),
              memoryFlushCompactionCount,
            }),
          });
          if (updatedEntry) {
            activeSessionEntry = updatedEntry;
          }
        } catch (err) {
          logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
        }
      }
    } catch (err) {
      logVerbose(`memory flush run failed: ${String(err)}`);
    }
  }

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
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
  const resetSessionAfterCompactionFailure = async (
    reason: string,
  ): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) return false;
    const nextSessionId = crypto.randomUUID();
    const nextEntry: SessionEntry = {
      ...(activeSessionStore[sessionKey] ?? activeSessionEntry),
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const topicId =
      typeof sessionCtx.MessageThreadId === "number"
        ? sessionCtx.MessageThreadId
        : undefined;
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      topicId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await saveSessionStore(storePath, activeSessionStore);
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after compaction failure (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(
      `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    );
    return true;
  };
  try {
    const runId = crypto.randomUUID();
    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }
    let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = followupRun.run.provider;
    let fallbackModel = followupRun.run.model;
    let didResetAfterCompactionFailure = false;
    while (true) {
      try {
        const allowPartialStream = !(
          followupRun.run.reasoningLevel === "stream" && opts?.onReasoningStream
        );
        const normalizeStreamingText = (
          payload: ReplyPayload,
        ): { text?: string; skip: boolean } => {
          if (!allowPartialStream) return { skip: true };
          let text = payload.text;
          if (!isHeartbeat && text?.includes("HEARTBEAT_OK")) {
            const stripped = stripHeartbeatToken(text, {
              mode: "message",
            });
            if (stripped.didStrip && !didLogHeartbeatStrip) {
              didLogHeartbeatStrip = true;
              logVerbose("Stripped stray HEARTBEAT_OK token from reply");
            }
            if (stripped.shouldSkip && (payload.mediaUrls?.length ?? 0) === 0) {
              return { skip: true };
            }
            text = stripped.text;
          }
          if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
            return { skip: true };
          }
          return { text, skip: false };
        };
        const handlePartialForTyping = async (
          payload: ReplyPayload,
        ): Promise<string | undefined> => {
          const { text, skip } = normalizeStreamingText(payload);
          if (skip || !text) return undefined;
          await typingSignals.signalTextDelta(text);
          return text;
        };
        const fallbackResult = await runWithModelFallback({
          cfg: followupRun.run.config,
          provider: followupRun.run.provider,
          model: followupRun.run.model,
          fallbacksOverride: resolveAgentModelFallbacksOverride(
            followupRun.run.config,
            resolveAgentIdFromSessionKey(followupRun.run.sessionKey),
          ),
          run: (provider, model) => {
            if (isCliProvider(provider, followupRun.run.config)) {
              const startedAt = Date.now();
              emitAgentEvent({
                runId,
                stream: "lifecycle",
                data: {
                  phase: "start",
                  startedAt,
                },
              });
              const cliSessionId = getCliSessionId(
                activeSessionEntry,
                provider,
              );
              return runCliAgent({
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
                cliSessionId,
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
              // Provider threading context for tool auto-injection
              ...buildThreadingToolContext({
                sessionCtx,
                config: followupRun.run.config,
                hasRepliedRef: opts?.hasRepliedRef,
              }),
              sessionFile: followupRun.run.sessionFile,
              workspaceDir: followupRun.run.workspaceDir,
              agentDir: followupRun.run.agentDir,
              config: followupRun.run.config,
              skillsSnapshot: followupRun.run.skillsSnapshot,
              prompt: commandBody,
              extraSystemPrompt: followupRun.run.extraSystemPrompt,
              ownerNumbers: followupRun.run.ownerNumbers,
              enforceFinalTag: resolveEnforceFinalTag(
                followupRun.run,
                provider,
              ),
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
              onPartialReply: allowPartialStream
                ? async (payload) => {
                    const textForTyping = await handlePartialForTyping(payload);
                    if (!opts?.onPartialReply || textForTyping === undefined)
                      return;
                    await opts.onPartialReply({
                      text: textForTyping,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
              onAssistantMessageStart: async () => {
                await typingSignals.signalMessageStart();
              },
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
                  if (phase === "start" || phase === "update") {
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
                      const { text, skip } = normalizeStreamingText(payload);
                      const hasPayloadMedia =
                        (payload.mediaUrls?.length ?? 0) > 0;
                      if (skip && !hasPayloadMedia) return;
                      const taggedPayload = applyReplyTagsToPayload(
                        {
                          text,
                          mediaUrls: payload.mediaUrls,
                          mediaUrl: payload.mediaUrls?.[0],
                        },
                        sessionCtx.MessageSid,
                      );
                      // Let through payloads with audioAsVoice flag even if empty (need to track it)
                      if (
                        !isRenderablePayload(taggedPayload) &&
                        !payload.audioAsVoice
                      )
                        return;
                      const parsed = parseReplyDirectives(
                        taggedPayload.text ?? "",
                        {
                          currentMessageId: sessionCtx.MessageSid,
                          silentToken: SILENT_REPLY_TOKEN,
                        },
                      );
                      const cleaned = parsed.text || undefined;
                      const hasRenderableMedia =
                        Boolean(taggedPayload.mediaUrl) ||
                        (taggedPayload.mediaUrls?.length ?? 0) > 0;
                      // Skip empty payloads unless they have audioAsVoice flag (need to track it)
                      if (
                        !cleaned &&
                        !hasRenderableMedia &&
                        !payload.audioAsVoice &&
                        !parsed.audioAsVoice
                      )
                        return;
                      if (parsed.isSilent && !hasRenderableMedia) return;

                      const blockPayload: ReplyPayload = applyReplyToMode({
                        ...taggedPayload,
                        text: cleaned,
                        audioAsVoice: Boolean(
                          parsed.audioAsVoice || payload.audioAsVoice,
                        ),
                        replyToId: taggedPayload.replyToId ?? parsed.replyToId,
                        replyToTag:
                          taggedPayload.replyToTag || parsed.replyToTag,
                        replyToCurrent:
                          taggedPayload.replyToCurrent || parsed.replyToCurrent,
                      });

                      void typingSignals
                        .signalTextDelta(cleaned ?? taggedPayload.text)
                        .catch((err) => {
                          logVerbose(
                            `block reply typing signal failed: ${String(err)}`,
                          );
                        });

                      blockReplyPipeline?.enqueue(blockPayload);
                    }
                  : undefined,
              onBlockReplyFlush:
                blockStreamingEnabled && blockReplyPipeline
                  ? async () => {
                      await blockReplyPipeline.flush({ force: true });
                    }
                  : undefined,
              shouldEmitToolResult,
              onToolResult: opts?.onToolResult
                ? (payload) => {
                    // `subscribeEmbeddedPiSession` may invoke tool callbacks without awaiting them.
                    // If a tool callback starts typing after the run finalized, we can end up with
                    // a typing loop that never sees a matching markRunComplete(). Track and drain.
                    const task = (async () => {
                      const { text, skip } = normalizeStreamingText(payload);
                      if (skip) return;
                      await typingSignals.signalTextDelta(text);
                      await opts.onToolResult?.({
                        text,
                        mediaUrls: payload.mediaUrls,
                      });
                    })()
                      .catch((err) => {
                        logVerbose(
                          `tool result delivery failed: ${String(err)}`,
                        );
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

        // Some embedded runs surface context overflow as an error payload instead of throwing.
        // Treat those as a session-level failure and auto-recover by starting a fresh session.
        const embeddedError = runResult.meta?.error;
        if (
          embeddedError &&
          isContextOverflowError(embeddedError.message) &&
          !didResetAfterCompactionFailure &&
          (await resetSessionAfterCompactionFailure(embeddedError.message))
        ) {
          didResetAfterCompactionFailure = true;
          continue;
        }

        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isContextOverflow =
          isContextOverflowError(message) ||
          /context.*overflow|too large|context window/i.test(message);
        const isCompactionFailure = isCompactionFailureError(message);
        const isSessionCorruption =
          /function call turn comes immediately after/i.test(message);

        if (
          isCompactionFailure &&
          !didResetAfterCompactionFailure &&
          (await resetSessionAfterCompactionFailure(message))
        ) {
          didResetAfterCompactionFailure = true;
          continue;
        }

        // Auto-recover from Gemini session corruption by resetting the session
        if (
          isSessionCorruption &&
          sessionKey &&
          activeSessionStore &&
          storePath
        ) {
          const corruptedSessionId = activeSessionEntry?.sessionId;
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
            delete activeSessionStore[sessionKey];
            await saveSessionStore(storePath, activeSessionStore);
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
            ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
            : `⚠️ Agent failed before reply: ${message}. Check gateway logs for details.`,
        });
      }
    }

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = Date.now();
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, activeSessionStore);
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
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
        const parsed = parseReplyDirectives(payload.text ?? "", {
          currentMessageId: sessionCtx.MessageSid,
          silentToken: SILENT_REPLY_TOKEN,
        });
        const mediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
        const mediaUrl = payload.mediaUrl ?? parsed.mediaUrl ?? mediaUrls?.[0];
        return {
          ...payload,
          text: parsed.text ? parsed.text : undefined,
          mediaUrls,
          mediaUrl,
          replyToId: payload.replyToId ?? parsed.replyToId,
          replyToTag: payload.replyToTag || parsed.replyToTag,
          replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
          audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
        };
      })
      .filter(isRenderablePayload);

    // Drop final payloads only when block streaming succeeded end-to-end.
    // If streaming aborted (e.g., timeout), fall back to final payloads.
    const shouldDropFinalPayloads =
      blockStreamingEnabled &&
      Boolean(blockReplyPipeline?.didStream()) &&
      !blockReplyPipeline?.isAborted();
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
            (payload) => !blockReplyPipeline?.hasSentPayload(payload),
          )
        : dedupedPayloads;
    const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

    if (replyPayloads.length === 0) return finalizeWithFollowup(undefined);

    const shouldSignalTyping = replyPayloads.some((payload) => {
      const trimmed = payload.text?.trim();
      if (trimmed) return true;
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
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    if (storePath && sessionKey) {
      if (hasNonzeroUsage(usage)) {
        try {
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async (entry) => {
              const input = usage.input ?? 0;
              const output = usage.output ?? 0;
              const promptTokens =
                input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              const patch: Partial<SessionEntry> = {
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
                const nextEntry = { ...entry, ...patch };
                setCliSessionId(nextEntry, providerUsed, cliSessionId);
                return {
                  ...patch,
                  cliSessionIds: nextEntry.cliSessionIds,
                  claudeCliSessionId: nextEntry.claudeCliSessionId,
                };
              }
              return patch;
            },
          });
        } catch (err) {
          logVerbose(`failed to persist usage update: ${String(err)}`);
        }
      } else if (modelUsed || contextTokensUsed) {
        try {
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async (entry) => {
              const patch: Partial<SessionEntry> = {
                modelProvider: providerUsed ?? entry.modelProvider,
                model: modelUsed ?? entry.model,
                contextTokens: contextTokensUsed ?? entry.contextTokens,
                updatedAt: Date.now(),
              };
              if (cliSessionId) {
                const nextEntry = { ...entry, ...patch };
                setCliSessionId(nextEntry, providerUsed, cliSessionId);
                return {
                  ...patch,
                  cliSessionIds: nextEntry.cliSessionIds,
                  claudeCliSessionId: nextEntry.claudeCliSessionId,
                };
              }
              return patch;
            },
          });
        } catch (err) {
          logVerbose(`failed to persist model/context update: ${String(err)}`);
        }
      }
    }

    const responseUsageEnabled =
      (activeSessionEntry?.responseUsage ??
        (sessionKey
          ? activeSessionStore?.[sessionKey]?.responseUsage
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
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
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
    if (resolvedVerboseLevel === "on" && activeIsNewSession) {
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
    blockReplyPipeline?.stop();
    typing.markRunComplete();
  }
}
