import crypto from "node:crypto";
import fs from "node:fs";
import { resolveAgentModelFallbacksOverride } from "../../agents/agent-scope.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId } from "../../agents/cli-session.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  isCompactionFailureError,
  isContextOverflowError,
} from "../../agents/pi-embedded-helpers.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { buildThreadingToolContext, resolveEnforceFinalTag } from "./agent-runner-utils.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { FollowupRun } from "./queue.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { applyReplyTagsToPayload, isRenderablePayload } from "./reply-payloads.js";
import type { TypingSignaler } from "./typing-mode.js";

export type AgentRunLoopResult =
  | {
      kind: "success";
      runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      didLogHeartbeatStrip: boolean;
      autoCompactionCompleted: boolean;
    }
  | { kind: "final"; payload: ReplyPayload };

export async function runAgentTurnWithFallback(params: {
  commandBody: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
  isHeartbeat: boolean;
  sessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
}): Promise<AgentRunLoopResult> {
  let didLogHeartbeatStrip = false;
  let autoCompactionCompleted = false;

  const runId = crypto.randomUUID();
  if (params.sessionKey) {
    registerAgentRunContext(runId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = params.followupRun.run.provider;
  let fallbackModel = params.followupRun.run.model;
  let didResetAfterCompactionFailure = false;

  while (true) {
    try {
      const allowPartialStream = !(
        params.followupRun.run.reasoningLevel === "stream" && params.opts?.onReasoningStream
      );
      const normalizeStreamingText = (payload: ReplyPayload): { text?: string; skip: boolean } => {
        if (!allowPartialStream) return { skip: true };
        let text = payload.text;
        if (!params.isHeartbeat && text?.includes("HEARTBEAT_OK")) {
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
      const handlePartialForTyping = async (payload: ReplyPayload): Promise<string | undefined> => {
        const { text, skip } = normalizeStreamingText(payload);
        if (skip || !text) return undefined;
        await params.typingSignals.signalTextDelta(text);
        return text;
      };
      const blockReplyPipeline = params.blockReplyPipeline;
      const onToolResult = params.opts?.onToolResult;
      const fallbackResult = await runWithModelFallback({
        cfg: params.followupRun.run.config,
        provider: params.followupRun.run.provider,
        model: params.followupRun.run.model,
        fallbacksOverride: resolveAgentModelFallbacksOverride(
          params.followupRun.run.config,
          resolveAgentIdFromSessionKey(params.followupRun.run.sessionKey),
        ),
        run: (provider, model) => {
          // Notify that model selection is complete (including after fallback).
          // This allows responsePrefix template interpolation with the actual model.
          params.opts?.onModelSelected?.({
            provider,
            model,
            thinkLevel: params.followupRun.run.thinkLevel,
          });

          if (isCliProvider(provider, params.followupRun.run.config)) {
            const startedAt = Date.now();
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              data: {
                phase: "start",
                startedAt,
              },
            });
            const cliSessionId = getCliSessionId(params.getActiveSessionEntry(), provider);
            return runCliAgent({
              sessionId: params.followupRun.run.sessionId,
              sessionKey: params.sessionKey,
              sessionFile: params.followupRun.run.sessionFile,
              workspaceDir: params.followupRun.run.workspaceDir,
              config: params.followupRun.run.config,
              prompt: params.commandBody,
              provider,
              model,
              thinkLevel: params.followupRun.run.thinkLevel,
              timeoutMs: params.followupRun.run.timeoutMs,
              runId,
              extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
              ownerNumbers: params.followupRun.run.ownerNumbers,
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
            sessionId: params.followupRun.run.sessionId,
            sessionKey: params.sessionKey,
            messageProvider: params.sessionCtx.Provider?.trim().toLowerCase() || undefined,
            agentAccountId: params.sessionCtx.AccountId,
            // Provider threading context for tool auto-injection
            ...buildThreadingToolContext({
              sessionCtx: params.sessionCtx,
              config: params.followupRun.run.config,
              hasRepliedRef: params.opts?.hasRepliedRef,
            }),
            sessionFile: params.followupRun.run.sessionFile,
            workspaceDir: params.followupRun.run.workspaceDir,
            agentDir: params.followupRun.run.agentDir,
            config: params.followupRun.run.config,
            skillsSnapshot: params.followupRun.run.skillsSnapshot,
            prompt: params.commandBody,
            extraSystemPrompt: params.followupRun.run.extraSystemPrompt,
            ownerNumbers: params.followupRun.run.ownerNumbers,
            enforceFinalTag: resolveEnforceFinalTag(params.followupRun.run, provider),
            provider,
            model,
            authProfileId: params.followupRun.run.authProfileId,
            thinkLevel: params.followupRun.run.thinkLevel,
            verboseLevel: params.followupRun.run.verboseLevel,
            reasoningLevel: params.followupRun.run.reasoningLevel,
            bashElevated: params.followupRun.run.bashElevated,
            timeoutMs: params.followupRun.run.timeoutMs,
            runId,
            blockReplyBreak: params.resolvedBlockStreamingBreak,
            blockReplyChunking: params.blockReplyChunking,
            onPartialReply: allowPartialStream
              ? async (payload) => {
                  const textForTyping = await handlePartialForTyping(payload);
                  if (!params.opts?.onPartialReply || textForTyping === undefined) return;
                  await params.opts.onPartialReply({
                    text: textForTyping,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              : undefined,
            onAssistantMessageStart: async () => {
              await params.typingSignals.signalMessageStart();
            },
            onReasoningStream:
              params.typingSignals.shouldStartOnReasoning || params.opts?.onReasoningStream
                ? async (payload) => {
                    await params.typingSignals.signalReasoningDelta();
                    await params.opts?.onReasoningStream?.({
                      text: payload.text,
                      mediaUrls: payload.mediaUrls,
                    });
                  }
                : undefined,
            onAgentEvent: (evt) => {
              // Trigger typing when tools start executing
              if (evt.stream === "tool") {
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                if (phase === "start" || phase === "update") {
                  void params.typingSignals.signalToolStart();
                }
              }
              // Track auto-compaction completion
              if (evt.stream === "compaction") {
                const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              }
            },
            onBlockReply:
              params.blockStreamingEnabled && params.opts?.onBlockReply
                ? async (payload) => {
                    const { text, skip } = normalizeStreamingText(payload);
                    const hasPayloadMedia = (payload.mediaUrls?.length ?? 0) > 0;
                    if (skip && !hasPayloadMedia) return;
                    const taggedPayload = applyReplyTagsToPayload(
                      {
                        text,
                        mediaUrls: payload.mediaUrls,
                        mediaUrl: payload.mediaUrls?.[0],
                      },
                      params.sessionCtx.MessageSid,
                    );
                    // Let through payloads with audioAsVoice flag even if empty (need to track it)
                    if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) return;
                    const parsed = parseReplyDirectives(taggedPayload.text ?? "", {
                      currentMessageId: params.sessionCtx.MessageSid,
                      silentToken: SILENT_REPLY_TOKEN,
                    });
                    const cleaned = parsed.text || undefined;
                    const hasRenderableMedia =
                      Boolean(taggedPayload.mediaUrl) || (taggedPayload.mediaUrls?.length ?? 0) > 0;
                    // Skip empty payloads unless they have audioAsVoice flag (need to track it)
                    if (
                      !cleaned &&
                      !hasRenderableMedia &&
                      !payload.audioAsVoice &&
                      !parsed.audioAsVoice
                    )
                      return;
                    if (parsed.isSilent && !hasRenderableMedia) return;

                    const blockPayload: ReplyPayload = params.applyReplyToMode({
                      ...taggedPayload,
                      text: cleaned,
                      audioAsVoice: Boolean(parsed.audioAsVoice || payload.audioAsVoice),
                      replyToId: taggedPayload.replyToId ?? parsed.replyToId,
                      replyToTag: taggedPayload.replyToTag || parsed.replyToTag,
                      replyToCurrent: taggedPayload.replyToCurrent || parsed.replyToCurrent,
                    });

                    void params.typingSignals
                      .signalTextDelta(cleaned ?? taggedPayload.text)
                      .catch((err) => {
                        logVerbose(`block reply typing signal failed: ${String(err)}`);
                      });

                    params.blockReplyPipeline?.enqueue(blockPayload);
                  }
                : undefined,
            onBlockReplyFlush:
              params.blockStreamingEnabled && blockReplyPipeline
                ? async () => {
                    await blockReplyPipeline.flush({ force: true });
                  }
                : undefined,
            shouldEmitToolResult: params.shouldEmitToolResult,
            onToolResult: onToolResult
              ? (payload) => {
                  // `subscribeEmbeddedPiSession` may invoke tool callbacks without awaiting them.
                  // If a tool callback starts typing after the run finalized, we can end up with
                  // a typing loop that never sees a matching markRunComplete(). Track and drain.
                  const task = (async () => {
                    const { text, skip } = normalizeStreamingText(payload);
                    if (skip) return;
                    await params.typingSignals.signalTextDelta(text);
                    await onToolResult({
                      text,
                      mediaUrls: payload.mediaUrls,
                    });
                  })()
                    .catch((err) => {
                      logVerbose(`tool result delivery failed: ${String(err)}`);
                    })
                    .finally(() => {
                      params.pendingToolTasks.delete(task);
                    });
                  params.pendingToolTasks.add(task);
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
        (await params.resetSessionAfterCompactionFailure(embeddedError.message))
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
      const isSessionCorruption = /function call turn comes immediately after/i.test(message);

      if (
        isCompactionFailure &&
        !didResetAfterCompactionFailure &&
        (await params.resetSessionAfterCompactionFailure(message))
      ) {
        didResetAfterCompactionFailure = true;
        continue;
      }

      // Auto-recover from Gemini session corruption by resetting the session
      if (
        isSessionCorruption &&
        params.sessionKey &&
        params.activeSessionStore &&
        params.storePath
      ) {
        const corruptedSessionId = params.getActiveSessionEntry()?.sessionId;
        defaultRuntime.error(
          `Session history corrupted (Gemini function call ordering). Resetting session: ${params.sessionKey}`,
        );

        try {
          // Delete transcript file if it exists
          if (corruptedSessionId) {
            const transcriptPath = resolveSessionTranscriptPath(corruptedSessionId);
            try {
              fs.unlinkSync(transcriptPath);
            } catch {
              // Ignore if file doesn't exist
            }
          }

          // Remove session entry from store
          delete params.activeSessionStore[params.sessionKey];
          await saveSessionStore(params.storePath, params.activeSessionStore);
        } catch (cleanupErr) {
          defaultRuntime.error(
            `Failed to reset corrupted session ${params.sessionKey}: ${String(cleanupErr)}`,
          );
        }

        return {
          kind: "final",
          payload: {
            text: "⚠️ Session history was corrupted. I've reset the conversation - please try again!",
          },
        };
      }

      defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
      return {
        kind: "final",
        payload: {
          text: isContextOverflow
            ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
            : `⚠️ Agent failed before reply: ${message}. Check gateway logs for details.`,
        },
      };
    }
  }

  return {
    kind: "success",
    runResult,
    fallbackProvider,
    fallbackModel,
    didLogHeartbeatStrip,
    autoCompactionCompleted,
  };
}
