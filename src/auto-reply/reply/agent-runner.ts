import crypto from "node:crypto";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  queueEmbeddedPiMessage,
  runEmbeddedPiAgent,
} from "../../agents/pi-embedded.js";
import {
  loadSessionStore,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { TemplateContext } from "../templating.js";
import { normalizeVerboseLevel, type VerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  enqueueFollowupRun,
  type FollowupRun,
  type QueueSettings,
  scheduleFollowupDrain,
} from "./queue.js";
import { extractReplyToTag } from "./reply-tags.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";

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
  } = params;

  const isHeartbeat = opts?.isHeartbeat === true;

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
  let didStreamBlockReply = false;
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
  try {
    const runId = crypto.randomUUID();
    if (sessionKey) {
      registerAgentRunContext(runId, { sessionKey });
    }
    let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = followupRun.run.provider;
    let fallbackModel = followupRun.run.model;
    try {
      const fallbackResult = await runWithModelFallback({
        cfg: followupRun.run.config,
        provider: followupRun.run.provider,
        model: followupRun.run.model,
        run: (provider, model) =>
          runEmbeddedPiAgent({
            sessionId: followupRun.run.sessionId,
            sessionKey,
            surface: sessionCtx.Surface?.trim().toLowerCase() || undefined,
            sessionFile: followupRun.run.sessionFile,
            workspaceDir: followupRun.run.workspaceDir,
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
            bashElevated: followupRun.run.bashElevated,
            timeoutMs: followupRun.run.timeoutMs,
            runId,
            blockReplyBreak: resolvedBlockStreamingBreak,
            blockReplyChunking,
            onPartialReply: opts?.onPartialReply
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
                  if (!isHeartbeat) {
                    await typing.startTypingOnText(text);
                  }
                  await opts.onPartialReply?.({
                    text,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              : undefined,
            onAgentEvent: (evt) => {
              if (evt.stream !== "compaction") return;
              const phase =
                typeof evt.data.phase === "string" ? evt.data.phase : "";
              const willRetry = Boolean(evt.data.willRetry);
              if (phase === "end" && !willRetry) {
                autoCompactionCompleted = true;
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
                    const tagResult = extractReplyToTag(
                      text,
                      sessionCtx.MessageSid,
                    );
                    const cleaned = tagResult.cleaned || undefined;
                    const hasMedia = (payload.mediaUrls?.length ?? 0) > 0;
                    if (!cleaned && !hasMedia) return;
                    if (cleaned?.trim() === SILENT_REPLY_TOKEN && !hasMedia)
                      return;
                    const blockPayload: ReplyPayload = {
                      text: cleaned,
                      mediaUrls: payload.mediaUrls,
                      mediaUrl: payload.mediaUrls?.[0],
                      replyToId: tagResult.replyToId,
                    };
                    const payloadKey = buildPayloadKey(blockPayload);
                    if (
                      streamedPayloadKeys.has(payloadKey) ||
                      pendingStreamedPayloadKeys.has(payloadKey)
                    ) {
                      return;
                    }
                    pendingStreamedPayloadKeys.add(payloadKey);
                    const task = (async () => {
                      if (!isHeartbeat) {
                        await typing.startTypingOnText(cleaned);
                      }
                      await opts.onBlockReply?.(blockPayload);
                    })()
                      .then(() => {
                        streamedPayloadKeys.add(payloadKey);
                        didStreamBlockReply = true;
                      })
                      .catch((err) => {
                        logVerbose(
                          `block reply delivery failed: ${String(err)}`,
                        );
                      })
                      .finally(() => {
                        pendingStreamedPayloadKeys.delete(payloadKey);
                      });
                    pendingBlockTasks.add(task);
                    void task.finally(() => pendingBlockTasks.delete(task));
                  }
                : undefined,
            shouldEmitToolResult,
            onToolResult: opts?.onToolResult
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
                  if (!isHeartbeat) {
                    await typing.startTypingOnText(text);
                  }
                  await opts.onToolResult?.({
                    text,
                    mediaUrls: payload.mediaUrls,
                  });
                }
              : undefined,
          }),
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isContextOverflow =
        /context.*overflow|too large|context window/i.test(message);
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
    if (payloadArray.length === 0) return finalizeWithFollowup(undefined);
    if (pendingBlockTasks.size > 0) {
      await Promise.allSettled(pendingBlockTasks);
    }

    const sanitizedPayloads = isHeartbeat
      ? payloadArray
      : payloadArray.flatMap((payload) => {
          const text = payload.text;
          if (!text || !text.includes("HEARTBEAT_OK")) return [payload];
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

    const replyTaggedPayloads: ReplyPayload[] = sanitizedPayloads
      .map((payload) => {
        const { cleaned, replyToId } = extractReplyToTag(
          payload.text,
          sessionCtx.MessageSid,
        );
        return {
          ...payload,
          text: cleaned ? cleaned : undefined,
          replyToId: replyToId ?? payload.replyToId,
        };
      })
      .filter(
        (payload) =>
          payload.text ||
          payload.mediaUrl ||
          (payload.mediaUrls && payload.mediaUrls.length > 0),
      );

    const shouldDropFinalPayloads =
      blockStreamingEnabled && didStreamBlockReply;
    const filteredPayloads = shouldDropFinalPayloads
      ? []
      : blockStreamingEnabled
        ? replyTaggedPayloads.filter(
            (payload) => !streamedPayloadKeys.has(buildPayloadKey(payload)),
          )
        : replyTaggedPayloads;

    if (filteredPayloads.length === 0) return finalizeWithFollowup(undefined);

    const shouldSignalTyping = filteredPayloads.some((payload) => {
      const trimmed = payload.text?.trim();
      if (trimmed && trimmed !== SILENT_REPLY_TOKEN) return true;
      if (payload.mediaUrl) return true;
      if (payload.mediaUrls && payload.mediaUrls.length > 0) return true;
      return false;
    });
    if (shouldSignalTyping && !isHeartbeat) {
      await typing.startTypingLoop();
    }

    if (sessionStore && sessionKey) {
      const usage = runResult.meta.agentMeta?.usage;
      const modelUsed =
        runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const providerUsed =
        runResult.meta.agentMeta?.provider ??
        fallbackProvider ??
        followupRun.run.provider;
      const contextTokensUsed =
        agentCfgContextTokens ??
        lookupContextTokens(modelUsed) ??
        sessionEntry?.contextTokens ??
        DEFAULT_CONTEXT_TOKENS;

      if (usage) {
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
          };
          if (storePath) {
            await saveSessionStore(storePath, sessionStore);
          }
        }
      }
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = filteredPayloads;
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

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
    );
  } finally {
    typing.markRunComplete();
  }
}
