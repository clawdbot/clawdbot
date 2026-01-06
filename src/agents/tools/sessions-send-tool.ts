import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  extractAssistantText,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  stripToolMessages,
} from "./sessions-helpers.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentMessageContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
  resolvePingPongTurns,
} from "./sessions-send-helpers.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.String(),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
});

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentSurface?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    description: "Send a message into another session.",
    parameters: SessionsSendToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey", {
        required: true,
      });
      const message = readStringParam(params, "message", { required: true });
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const visibility =
        cfg.agent?.sandbox?.sessionToolsVisibility ?? "spawned";
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : undefined;
      const resolvedKey = resolveInternalSessionKey({
        key: sessionKey,
        alias,
        mainKey,
      });
      const restrictToSpawned =
        opts?.sandboxed === true &&
        visibility === "spawned" &&
        requesterInternalKey &&
        !requesterInternalKey.toLowerCase().startsWith("subagent:");
      if (restrictToSpawned) {
        try {
          const list = (await callGateway({
            method: "sessions.list",
            params: {
              includeGlobal: false,
              includeUnknown: false,
              limit: 500,
              spawnedBy: requesterInternalKey,
            },
          })) as { sessions?: Array<Record<string, unknown>> };
          const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
          const ok = sessions.some((entry) => entry?.key === resolvedKey);
          if (!ok) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: `Session not visible from this sandboxed agent session: ${sessionKey}`,
              sessionKey: resolveDisplaySessionKey({
                key: sessionKey,
                alias,
                mainKey,
              }),
            });
          }
        } catch {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: `Session not visible from this sandboxed agent session: ${sessionKey}`,
            sessionKey: resolveDisplaySessionKey({
              key: sessionKey,
              alias,
              mainKey,
            }),
          });
        }
      }
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" &&
        Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const displayKey = resolveDisplaySessionKey({
        key: sessionKey,
        alias,
        mainKey,
      });
      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterSurface: opts?.agentSurface,
        targetSessionKey: displayKey,
      });
      const sendParams = {
        message,
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        lane: "nested",
        extraSystemPrompt: agentMessageContext,
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterSurface = opts?.agentSurface;
      const maxPingPongTurns = resolvePingPongTurns(cfg);

      const runAgentToAgentFlow = async (
        roundOneReply?: string,
        runInfo?: { runId: string },
      ) => {
        try {
          let primaryReply = roundOneReply;
          let latestReply = roundOneReply;
          if (!primaryReply && runInfo?.runId) {
            const waitMs = Math.min(announceTimeoutMs, 60_000);
            const wait = (await callGateway({
              method: "agent.wait",
              params: {
                runId: runInfo.runId,
                timeoutMs: waitMs,
              },
              timeoutMs: waitMs + 2000,
            })) as { status?: string };
            if (wait?.status === "ok") {
              primaryReply = await readLatestAssistantReply({
                sessionKey: resolvedKey,
              });
              latestReply = primaryReply;
            }
          }
          if (!latestReply) return;
          const announceTarget = await resolveAnnounceTarget({
            sessionKey: resolvedKey,
            displayKey,
          });
          const targetChannel = announceTarget?.channel ?? "unknown";
          if (
            maxPingPongTurns > 0 &&
            requesterSessionKey &&
            requesterSessionKey !== resolvedKey
          ) {
            let currentSessionKey = requesterSessionKey;
            let nextSessionKey = resolvedKey;
            let incomingMessage = latestReply;
            for (let turn = 1; turn <= maxPingPongTurns; turn += 1) {
              const currentRole =
                currentSessionKey === requesterSessionKey
                  ? "requester"
                  : "target";
              const replyPrompt = buildAgentToAgentReplyContext({
                requesterSessionKey,
                requesterSurface,
                targetSessionKey: displayKey,
                targetChannel,
                currentRole,
                turn,
                maxTurns: maxPingPongTurns,
              });
              const replyText = await runAgentStep({
                sessionKey: currentSessionKey,
                message: incomingMessage,
                extraSystemPrompt: replyPrompt,
                timeoutMs: announceTimeoutMs,
                lane: "nested",
              });
              if (!replyText || isReplySkip(replyText)) {
                break;
              }
              latestReply = replyText;
              incomingMessage = replyText;
              const swap = currentSessionKey;
              currentSessionKey = nextSessionKey;
              nextSessionKey = swap;
            }
          }
          const announcePrompt = buildAgentToAgentAnnounceContext({
            requesterSessionKey,
            requesterSurface,
            targetSessionKey: displayKey,
            targetChannel,
            originalMessage: message,
            roundOneReply: primaryReply,
            latestReply,
          });
          const announceReply = await runAgentStep({
            sessionKey: resolvedKey,
            message: "Agent-to-agent announce step.",
            extraSystemPrompt: announcePrompt,
            timeoutMs: announceTimeoutMs,
            lane: "nested",
          });
          if (
            announceTarget &&
            announceReply &&
            announceReply.trim() &&
            !isAnnounceSkip(announceReply)
          ) {
            await callGateway({
              method: "send",
              params: {
                to: announceTarget.to,
                message: announceReply.trim(),
                provider: announceTarget.channel,
                idempotencyKey: crypto.randomUUID(),
              },
              timeoutMs: 10_000,
            });
          }
        } catch {
          // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
        }
      };

      if (timeoutSeconds === 0) {
        try {
          const response = (await callGateway({
            method: "agent",
            params: sendParams,
            timeoutMs: 10_000,
          })) as { runId?: string; acceptedAt?: number };
          if (typeof response?.runId === "string" && response.runId) {
            runId = response.runId;
          }
          void runAgentToAgentFlow(undefined, { runId });
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
          });
        } catch (err) {
          const messageText =
            err instanceof Error
              ? err.message
              : typeof err === "string"
                ? err
                : "error";
          return jsonResult({
            runId,
            status: "error",
            error: messageText,
            sessionKey: displayKey,
          });
        }
      }

      try {
        const response = (await callGateway({
          method: "agent",
          params: sendParams,
          timeoutMs: 10_000,
        })) as { runId?: string; acceptedAt?: number };
        if (typeof response?.runId === "string" && response.runId) {
          runId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          runId,
          status: "error",
          error: messageText,
          sessionKey: displayKey,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = (await callGateway({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs,
          },
          timeoutMs: timeoutMs + 2000,
        })) as { status?: string; error?: string };
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          runId,
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          sessionKey: displayKey,
        });
      }

      if (waitStatus === "timeout") {
        return jsonResult({
          runId,
          status: "timeout",
          error: waitError,
          sessionKey: displayKey,
        });
      }
      if (waitStatus === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: waitError ?? "agent error",
          sessionKey: displayKey,
        });
      }

      const history = (await callGateway({
        method: "chat.history",
        params: { sessionKey: resolvedKey, limit: 50 },
      })) as { messages?: unknown[] };
      const filtered = stripToolMessages(
        Array.isArray(history?.messages) ? history.messages : [],
      );
      const last =
        filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
      const reply = last ? extractAssistantText(last) : undefined;
      void runAgentToAgentFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
      });
    },
  };
}
