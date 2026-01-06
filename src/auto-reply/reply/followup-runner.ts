import crypto from "node:crypto";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { defaultRuntime } from "../../runtime.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import { extractReplyToTag } from "./reply-tags.js";
import { incrementCompactionCount } from "./session-updates.js";
import type { TypingController } from "./typing.js";

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
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
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;

  const sendFollowupPayloads = async (payloads: ReplyPayload[]) => {
    if (!opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }
    for (const payload of payloads) {
      if (!payload?.text && !payload?.mediaUrl && !payload?.mediaUrls?.length) {
        continue;
      }
      if (
        payload.text?.trim() === SILENT_REPLY_TOKEN &&
        !payload.mediaUrl &&
        !payload.mediaUrls?.length
      ) {
        continue;
      }
      await typing.startTypingOnText(payload.text);
      await opts.onBlockReply(payload);
    }
  };

  return async (queued: FollowupRun) => {
    try {
      const runId = crypto.randomUUID();
      if (queued.run.sessionKey) {
        registerAgentRunContext(runId, { sessionKey: queued.run.sessionKey });
      }
      let autoCompactionCompleted = false;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = queued.run.provider;
      let fallbackModel = queued.run.model;
      try {
        const fallbackResult = await runWithModelFallback({
          cfg: queued.run.config,
          provider: queued.run.provider,
          model: queued.run.model,
          run: (provider, model) =>
            runEmbeddedPiAgent({
              sessionId: queued.run.sessionId,
              sessionKey: queued.run.sessionKey,
              surface: queued.run.surface,
              sessionFile: queued.run.sessionFile,
              workspaceDir: queued.run.workspaceDir,
              config: queued.run.config,
              skillsSnapshot: queued.run.skillsSnapshot,
              prompt: queued.prompt,
              extraSystemPrompt: queued.run.extraSystemPrompt,
              ownerNumbers: queued.run.ownerNumbers,
              enforceFinalTag: queued.run.enforceFinalTag,
              provider,
              model,
              authProfileId: queued.run.authProfileId,
              thinkLevel: queued.run.thinkLevel,
              verboseLevel: queued.run.verboseLevel,
              bashElevated: queued.run.bashElevated,
              timeoutMs: queued.run.timeoutMs,
              runId,
              blockReplyBreak: queued.run.blockReplyBreak,
              onAgentEvent: (evt) => {
                if (evt.stream !== "compaction") return;
                const phase =
                  typeof evt.data.phase === "string" ? evt.data.phase : "";
                const willRetry = Boolean(evt.data.willRetry);
                if (phase === "end" && !willRetry) {
                  autoCompactionCompleted = true;
                }
              },
            }),
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        defaultRuntime.error?.(
          `Followup agent failed before reply: ${message}`,
        );
        return;
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) return;
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const text = payload.text;
        if (!text || !text.includes("HEARTBEAT_OK")) return [payload];
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const hasMedia =
          Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) return [];
        return [{ ...payload, text: stripped.text }];
      });

      const replyTaggedPayloads: ReplyPayload[] = sanitizedPayloads
        .map((payload) => {
          const { cleaned, replyToId } = extractReplyToTag(payload.text);
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

      if (replyTaggedPayloads.length === 0) return;

      if (autoCompactionCompleted) {
        const count = await incrementCompactionCount({
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        });
        if (queued.run.verboseLevel === "on") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          replyTaggedPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      if (sessionStore && sessionKey) {
        const usage = runResult.meta.agentMeta?.usage;
        const modelUsed =
          runResult.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
        const contextTokensUsed =
          agentCfgContextTokens ??
          lookupContextTokens(modelUsed) ??
          sessionEntry?.contextTokens ??
          DEFAULT_CONTEXT_TOKENS;

        if (usage) {
          const entry = sessionStore[sessionKey];
          if (entry) {
            const input = usage.input ?? 0;
            const output = usage.output ?? 0;
            const promptTokens =
              input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
            sessionStore[sessionKey] = {
              ...entry,
              inputTokens: input,
              outputTokens: output,
              totalTokens:
                promptTokens > 0 ? promptTokens : (usage.total ?? input),
              modelProvider: fallbackProvider ?? entry.modelProvider,
              model: modelUsed,
              contextTokens: contextTokensUsed ?? entry.contextTokens,
              updatedAt: Date.now(),
            };
            if (storePath) {
              await saveSessionStore(storePath, sessionStore);
            }
          }
        } else if (modelUsed || contextTokensUsed) {
          const entry = sessionStore[sessionKey];
          if (entry) {
            sessionStore[sessionKey] = {
              ...entry,
              modelProvider: fallbackProvider ?? entry.modelProvider,
              model: modelUsed ?? entry.model,
              contextTokens: contextTokensUsed ?? entry.contextTokens,
            };
            if (storePath) {
              await saveSessionStore(storePath, sessionStore);
            }
          }
        }
      }

      await sendFollowupPayloads(replyTaggedPayloads);
    } finally {
      typing.markRunComplete();
    }
  };
}
