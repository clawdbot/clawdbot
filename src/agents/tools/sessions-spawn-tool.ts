import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";
import { isAnnounceSkip } from "./sessions-send-helpers.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  cleanup: Type.Optional(
    Type.Union([Type.Literal("delete"), Type.Literal("keep")]),
  ),
});

function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterSurface?: string;
  childSessionKey: string;
  label?: string;
}) {
  const lines = [
    "Sub-agent context:",
    params.label ? `Label: ${params.label}` : undefined,
    params.requesterSessionKey
      ? `Requester session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterSurface
      ? `Requester surface: ${params.requesterSurface}.`
      : undefined,
    `Your session: ${params.childSessionKey}.`,
    "Run the task. Provide a clear final answer (plain text).",
    'After you finish, you may be asked to produce an "announce" message to post back to the requester chat.',
  ].filter(Boolean);
  return lines.join("\n");
}

function buildSubagentAnnouncePrompt(params: {
  requesterSessionKey?: string;
  requesterSurface?: string;
  announceChannel: string;
  task: string;
  subagentReply?: string;
}) {
  const lines = [
    "Sub-agent announce step:",
    params.requesterSessionKey
      ? `Requester session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterSurface
      ? `Requester surface: ${params.requesterSurface}.`
      : undefined,
    `Post target surface: ${params.announceChannel}.`,
    `Original task: ${params.task}`,
    params.subagentReply
      ? `Sub-agent result: ${params.subagentReply}`
      : "Sub-agent result: (not available).",
    'Reply exactly "ANNOUNCE_SKIP" to stay silent.',
    "Any other reply will be posted to the requester chat surface.",
  ].filter(Boolean);
  return lines.join("\n");
}

async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterSurface?: string;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
}) {
  try {
    let reply = params.roundOneReply;
    if (!reply) {
      const waitMs = Math.min(params.timeoutMs, 60_000);
      const wait = (await callGateway({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      })) as { status?: string };
      if (wait?.status !== "ok") return;
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.requesterSessionKey,
      displayKey: params.requesterDisplayKey,
    });
    if (!announceTarget) return;

    const announcePrompt = buildSubagentAnnouncePrompt({
      requesterSessionKey: params.requesterSessionKey,
      requesterSurface: params.requesterSurface,
      announceChannel: announceTarget.channel,
      task: params.task,
      subagentReply: reply,
    });

    const announceReply = await runAgentStep({
      sessionKey: params.childSessionKey,
      message: "Sub-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.timeoutMs,
      lane: "nested",
    });

    if (
      !announceReply ||
      !announceReply.trim() ||
      isAnnounceSkip(announceReply)
    )
      return;

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
  } catch {
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    if (params.cleanup === "delete") {
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: params.childSessionKey, deleteTranscript: true },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
}

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentSurface?: string;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete"
          ? (params.cleanup as "keep" | "delete")
          : "delete";
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" &&
        Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 0;
      const timeoutMs = timeoutSeconds * 1000;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      if (
        typeof requesterSessionKey === "string" &&
        requesterSessionKey.trim().toLowerCase().startsWith("subagent:")
      ) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const childSessionKey = `subagent:${crypto.randomUUID()}`;
      if (opts?.sandboxed === true) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: childSessionKey, spawnedBy: requesterInternalKey },
            timeoutMs: 10_000,
          });
        } catch {
          // best-effort; scoping relies on this metadata but spawning still works without it
        }
      }
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterSurface: opts?.agentSurface,
        childSessionKey,
        label: label || undefined,
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            idempotencyKey: childIdem,
            deliver: false,
            lane: "subagent",
            extraSystemPrompt: childSystemPrompt,
          },
          timeoutMs: 10_000,
        })) as { runId?: string };
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
      } catch (err) {
        const messageText =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "error";
        return jsonResult({
          status: "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      if (timeoutSeconds === 0) {
        void runSubagentAnnounceFlow({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          requesterSurface: opts?.agentSurface,
          requesterDisplayKey,
          task,
          timeoutMs: 30_000,
          cleanup,
        });
        return jsonResult({
          status: "accepted",
          childSessionKey,
          runId: childRunId,
        });
      }

      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = (await callGateway({
          method: "agent.wait",
          params: {
            runId: childRunId,
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
          status: messageText.includes("gateway timeout") ? "timeout" : "error",
          error: messageText,
          childSessionKey,
          runId: childRunId,
        });
      }

      if (waitStatus === "timeout") {
        void runSubagentAnnounceFlow({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          requesterSurface: opts?.agentSurface,
          requesterDisplayKey,
          task,
          timeoutMs: 30_000,
          cleanup,
        });
        return jsonResult({
          status: "timeout",
          error: waitError,
          childSessionKey,
          runId: childRunId,
        });
      }
      if (waitStatus === "error") {
        void runSubagentAnnounceFlow({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          requesterSurface: opts?.agentSurface,
          requesterDisplayKey,
          task,
          timeoutMs: 30_000,
          cleanup,
        });
        return jsonResult({
          status: "error",
          error: waitError ?? "agent error",
          childSessionKey,
          runId: childRunId,
        });
      }

      const replyText = await readLatestAssistantReply({
        sessionKey: childSessionKey,
      });
      void runSubagentAnnounceFlow({
        childSessionKey,
        childRunId,
        requesterSessionKey: requesterInternalKey,
        requesterSurface: opts?.agentSurface,
        requesterDisplayKey,
        task,
        timeoutMs: 30_000,
        cleanup,
        roundOneReply: replyText,
      });

      return jsonResult({
        status: "ok",
        childSessionKey,
        runId: childRunId,
        reply: replyText,
      });
    },
  };
}
