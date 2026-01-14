import crypto from "node:crypto";
import path from "node:path";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "./lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./tools/agent-step.js";
import { resolveAnnounceTarget } from "./tools/sessions-announce-target.js";
import { isAnnounceSkip } from "./tools/sessions-send-helpers.js";

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return undefined;
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(value?: number) {
  if (!value || !Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatUsd(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function resolveModelCost(params: {
  provider?: string;
  model?: string;
  config: ReturnType<typeof loadConfig>;
}):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) return undefined;
  const models = params.config.models?.providers?.[provider]?.models ?? [];
  const entry = models.find((candidate) => candidate.id === model);
  return entry?.cost;
}

async function waitForSessionUsage(params: { sessionKey: string }) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  if (!entry) return { entry, storePath };
  const hasTokens = () =>
    entry &&
    (typeof entry.totalTokens === "number" ||
      typeof entry.inputTokens === "number" ||
      typeof entry.outputTokens === "number");
  if (hasTokens()) return { entry, storePath };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    entry = loadSessionStore(storePath)[params.sessionKey];
    if (hasTokens()) break;
  }
  return { entry, storePath };
}

async function buildSubagentStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = loadConfig();
  const { entry, storePath } = await waitForSessionUsage({
    sessionKey: params.sessionKey,
  });

  const sessionId = entry?.sessionId;
  const transcriptPath =
    sessionId && storePath
      ? path.join(path.dirname(storePath), `${sessionId}.jsonl`)
      : undefined;

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const total =
    entry?.totalTokens ??
    (typeof input === "number" && typeof output === "number"
      ? input + output
      : undefined);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const provider = entry?.modelProvider;
  const model = entry?.model;
  const costConfig = resolveModelCost({ provider, model, config: cfg });
  const cost =
    costConfig && typeof input === "number" && typeof output === "number"
      ? (input * costConfig.input + output * costConfig.output) / 1_000_000
      : undefined;

  const parts: string[] = [];
  const runtime = formatDurationShort(runtimeMs);
  parts.push(`runtime ${runtime ?? "n/a"}`);
  if (typeof total === "number") {
    const inputText =
      typeof input === "number" ? formatTokenCount(input) : "n/a";
    const outputText =
      typeof output === "number" ? formatTokenCount(output) : "n/a";
    const totalText = formatTokenCount(total);
    parts.push(`tokens ${totalText} (in ${inputText} / out ${outputText})`);
  } else {
    parts.push("tokens n/a");
  }
  const costText = formatUsd(cost);
  if (costText) parts.push(`est ${costText}`);
  parts.push(`sessionKey ${params.sessionKey}`);
  if (sessionId) parts.push(`sessionId ${sessionId}`);
  if (transcriptPath) parts.push(`transcript ${transcriptPath}`);

  return `Stats: ${parts.join(" \u2022 ")}`;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  childSessionKey: string;
  label?: string;
  task?: string;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";
  const lines = [
    "# Subagent Context",
    "",
    "You are a **subagent** spawned by the main agent for a specific task.",
    "",
    "## Your Role",
    `- You were created to handle: ${taskText}`,
    "- Complete this task and report back. That's your entire purpose.",
    "- You are NOT the main agent. Don't try to be.",
    "",
    "## Rules",
    "1. **Stay focused** - Do your assigned task, nothing else",
    "2. **Report completion** - When done, summarize results clearly",
    "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
    "4. **Ask the spawner** - If blocked or confused, report back rather than improvising",
    "5. **Be ephemeral** - You may be terminated after task completion. That's fine.",
    "",
    "## What You DON'T Do",
    "- NO user conversations (that's main agent's job)",
    "- NO external messages (email, tweets, etc.) unless explicitly tasked",
    "- NO cron jobs or persistent state",
    "- NO pretending to be the main agent",
    "",
    "## Output Format",
    "When complete, respond with:",
    "- **Status:** success | failed | blocked",
    "- **Result:** [what you accomplished]",
    "- **Notes:** [anything the main agent should know] - discuss gimme options",
    "",
    "## Session Context",
    params.label ? `- Label: ${params.label}` : undefined,
    params.requesterSessionKey
      ? `- Requester session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `- Requester channel: ${params.requesterChannel}.`
      : undefined,
    `- Your session: ${params.childSessionKey}.`,
    "",
    "Run the task. Provide a clear final answer (plain text).",
    'After you finish, you may be asked to produce an "announce" message to post back to the requester chat.',
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function buildSubagentAnnouncePrompt(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  announceChannel: string;
  task: string;
  subagentReply?: string;
}) {
  const lines = [
    "Sub-agent announce step:",
    params.requesterSessionKey
      ? `Requester session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `Requester channel: ${params.requesterChannel}.`
      : undefined,
    `Post target channel: ${params.announceChannel}.`,
    `Original task: ${params.task}`,
    params.subagentReply
      ? `Sub-agent result: ${params.subagentReply}`
      : "Sub-agent result: (not available).",
    "",
    "**You MUST announce your result.** The requester is waiting for your response.",
    "Provide a brief, useful summary of what you accomplished.",
    'Only reply "ANNOUNCE_SKIP" if the task completely failed with no useful output.',
    "Your reply will be posted to the requester chat.",
  ].filter(Boolean);
  return lines.join("\n");
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterChannel?: string;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
}): Promise<boolean> {
  let didAnnounce = false;
  try {
    let reply = params.roundOneReply;
    if (!reply && params.waitForCompletion !== false) {
      const waitMs = Math.min(params.timeoutMs, 60_000);
      const wait = (await callGateway({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      })) as { status?: string };
      if (wait?.status !== "ok") return false;
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!reply) {
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.requesterSessionKey,
      displayKey: params.requesterDisplayKey,
    });
    if (!announceTarget) return false;

    const announcePrompt = buildSubagentAnnouncePrompt({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      announceChannel: announceTarget.channel,
      task: params.task,
      subagentReply: reply,
    });

    const announceReply = await runAgentStep({
      sessionKey: params.childSessionKey,
      message: "Sub-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.timeoutMs,
      channel: INTERNAL_MESSAGE_CHANNEL,
      lane: AGENT_LANE_NESTED,
    });

    if (
      !announceReply ||
      !announceReply.trim() ||
      isAnnounceSkip(announceReply)
    )
      return false;

    const statsLine = await buildSubagentStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const message = statsLine
      ? `${announceReply.trim()}\n\n${statsLine}`
      : announceReply.trim();

    await callGateway({
      method: "send",
      params: {
        to: announceTarget.to,
        message,
        channel: announceTarget.channel,
        accountId: announceTarget.accountId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
    didAnnounce = true;
  } catch {
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
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
  return didAnnounce;
}
