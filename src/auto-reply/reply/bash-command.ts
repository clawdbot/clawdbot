import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  getFinishedSession,
  getSession,
  markExited,
} from "../../agents/bash-process-registry.js";
import { createExecTool } from "../../agents/bash-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { killProcessTree } from "../../agents/shell-utils.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

const CHAT_BASH_SCOPE_KEY = "chat:bash";
const DEFAULT_FOREGROUND_MS = 2000;
const MAX_FOREGROUND_MS = 30_000;

type BashRequest =
  | { action: "help" }
  | { action: "run"; command: string }
  | { action: "poll"; sessionId?: string }
  | { action: "stop"; sessionId?: string };

type ActiveBashJob =
  | { state: "starting"; startedAt: number; command: string }
  | {
      state: "running";
      sessionId: string;
      startedAt: number;
      command: string;
      watcherAttached: boolean;
    };

let activeJob: ActiveBashJob | null = null;

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function resolveForegroundMs(cfg: ClawdbotConfig): number {
  const raw = cfg.commands?.bashForegroundMs;
  if (typeof raw !== "number" || Number.isNaN(raw))
    return DEFAULT_FOREGROUND_MS;
  return clampNumber(Math.floor(raw), 0, MAX_FOREGROUND_MS);
}

function formatSessionSnippet(sessionId: string) {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
}

function formatOutputBlock(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "(no output)";
  return `\`\`\`txt\n${trimmed}\n\`\`\``;
}

function parseBashRequest(raw: string): BashRequest | null {
  const trimmed = raw.trimStart();
  let restSource = "";
  if (trimmed.toLowerCase().startsWith("/bash")) {
    const match = trimmed.match(/^\/bash(?:\s*:\s*|\s+|$)([\s\S]*)$/i);
    if (!match) return null;
    restSource = match[1] ?? "";
  } else if (trimmed.startsWith("!")) {
    restSource = trimmed.slice(1);
    if (restSource.trimStart().startsWith(":")) {
      restSource = restSource.trimStart().slice(1);
    }
  } else {
    return null;
  }

  const rest = restSource.trimStart();
  if (!rest) return { action: "help" };
  const tokenMatch = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const token = tokenMatch?.[1]?.trim() ?? "";
  const remainder = tokenMatch?.[2]?.trim() ?? "";
  const lowered = token.toLowerCase();
  if (lowered === "poll") {
    return { action: "poll", sessionId: remainder || undefined };
  }
  if (lowered === "stop") {
    return { action: "stop", sessionId: remainder || undefined };
  }
  if (lowered === "help") {
    return { action: "help" };
  }
  return { action: "run", command: rest };
}

function resolveRawCommandBody(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentId?: string;
  isGroup: boolean;
}) {
  const source =
    params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body ?? "";
  const stripped = stripStructuralPrefixes(source);
  return params.isGroup
    ? stripMentions(stripped, params.ctx, params.cfg, params.agentId)
    : stripped;
}

function getScopedSession(sessionId: string) {
  const running = getSession(sessionId);
  if (running && running.scopeKey === CHAT_BASH_SCOPE_KEY) return { running };
  const finished = getFinishedSession(sessionId);
  if (finished && finished.scopeKey === CHAT_BASH_SCOPE_KEY)
    return { finished };
  return {};
}

function ensureActiveJobState() {
  if (!activeJob) return null;
  if (activeJob.state === "starting") return activeJob;
  const { running, finished } = getScopedSession(activeJob.sessionId);
  if (running) return activeJob;
  if (finished) {
    activeJob = null;
    return null;
  }
  activeJob = null;
  return null;
}

function attachActiveWatcher(sessionId: string) {
  if (!activeJob || activeJob.state !== "running") return;
  if (activeJob.sessionId !== sessionId) return;
  if (activeJob.watcherAttached) return;
  const { running } = getScopedSession(sessionId);
  const child = running?.child;
  if (!child) return;
  activeJob.watcherAttached = true;
  child.once("close", () => {
    if (activeJob?.state === "running" && activeJob.sessionId === sessionId) {
      activeJob = null;
    }
  });
}

function buildUsageReply(): ReplyPayload {
  return {
    text: [
      "⚙️ Usage:",
      "- ! <command>",
      "- !poll | ! poll",
      "- !stop | ! stop",
      "- /bash ... (alias; same subcommands as !)",
    ].join("\n"),
  };
}

function formatElevatedUnavailableMessage(params: {
  runtimeSandboxed: boolean;
  failures: Array<{ gate: string; key: string }>;
  sessionKey?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`,
  );
  if (params.failures.length > 0) {
    lines.push(
      `Failing gates: ${params.failures
        .map((f) => `${f.gate} (${f.key})`)
        .join(", ")}`,
    );
  } else {
    lines.push(
      "Failing gates: enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled), allowFrom (tools.elevated.allowFrom.<provider>).",
    );
  }
  lines.push("Fix-it keys:");
  lines.push("- tools.elevated.enabled");
  lines.push("- tools.elevated.allowFrom.<provider>");
  lines.push("- agents.list[].tools.elevated.enabled");
  lines.push("- agents.list[].tools.elevated.allowFrom.<provider>");
  if (params.sessionKey) {
    lines.push(`See: clawdbot sandbox explain --session ${params.sessionKey}`);
  }
  return lines.join("\n");
}

export async function handleBashChatCommand(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  agentId?: string;
  sessionKey: string;
  isGroup: boolean;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{ gate: string; key: string }>;
  };
}): Promise<ReplyPayload> {
  if (params.cfg.commands?.bash !== true) {
    return {
      text: "⚠️ bash is disabled. Set commands.bash=true to enable.",
    };
  }

  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });

  if (!params.elevated.enabled || !params.elevated.allowed) {
    const runtimeSandboxed = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.ctx.SessionKey,
    }).sandboxed;
    return {
      text: formatElevatedUnavailableMessage({
        runtimeSandboxed,
        failures: params.elevated.failures,
        sessionKey: params.ctx.SessionKey,
      }),
    };
  }

  const rawBody = resolveRawCommandBody({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId,
    isGroup: params.isGroup,
  }).trim();
  const request = parseBashRequest(rawBody);
  if (!request) {
    return { text: "⚠️ Unrecognized bash request." };
  }

  const liveJob = ensureActiveJobState();

  if (request.action === "help") {
    return buildUsageReply();
  }

  if (request.action === "poll") {
    const sessionId =
      request.sessionId?.trim() ||
      (liveJob?.state === "running" ? liveJob.sessionId : "");
    if (!sessionId) {
      return { text: "⚙️ No active bash job." };
    }
    const { running, finished } = getScopedSession(sessionId);
    if (running) {
      attachActiveWatcher(sessionId);
      const runtimeSec = Math.max(
        0,
        Math.floor((Date.now() - running.startedAt) / 1000),
      );
      const tail = running.tail || "(no output yet)";
      return {
        text: [
          `⚙️ bash still running (session ${formatSessionSnippet(sessionId)}, ${runtimeSec}s).`,
          formatOutputBlock(tail),
          "Hint: !stop (or /bash stop)",
        ].join("\n"),
      };
    }
    if (finished) {
      if (activeJob?.state === "running" && activeJob.sessionId === sessionId) {
        activeJob = null;
      }
      const exitLabel = finished.exitSignal
        ? `signal ${String(finished.exitSignal)}`
        : `code ${String(finished.exitCode ?? 0)}`;
      const prefix = finished.status === "completed" ? "⚙️" : "⚠️";
      return {
        text: [
          `${prefix} bash finished (session ${formatSessionSnippet(sessionId)}).`,
          `Exit: ${exitLabel}`,
          formatOutputBlock(finished.aggregated || finished.tail),
        ].join("\n"),
      };
    }
    if (activeJob?.state === "running" && activeJob.sessionId === sessionId) {
      activeJob = null;
    }
    return {
      text: `⚙️ No bash session found for ${formatSessionSnippet(sessionId)}.`,
    };
  }

  if (request.action === "stop") {
    const sessionId =
      request.sessionId?.trim() ||
      (liveJob?.state === "running" ? liveJob.sessionId : "");
    if (!sessionId) {
      return { text: "⚙️ No active bash job." };
    }
    const { running } = getScopedSession(sessionId);
    if (!running) {
      if (activeJob?.state === "running" && activeJob.sessionId === sessionId) {
        activeJob = null;
      }
      return {
        text: `⚙️ No running bash job found for ${formatSessionSnippet(sessionId)}.`,
      };
    }
    if (!running.backgrounded) {
      return {
        text: `⚠️ Session ${formatSessionSnippet(sessionId)} is not backgrounded.`,
      };
    }
    const pid = running.pid ?? running.child?.pid;
    if (pid) {
      killProcessTree(pid);
    }
    markExited(running, null, "SIGKILL", "failed");
    if (activeJob?.state === "running" && activeJob.sessionId === sessionId) {
      activeJob = null;
    }
    return {
      text: `⚙️ bash stopped (session ${formatSessionSnippet(sessionId)}).`,
    };
  }

  // request.action === "run"
  if (liveJob) {
    const label =
      liveJob.state === "running"
        ? formatSessionSnippet(liveJob.sessionId)
        : "starting";
    return {
      text: `⚠️ A bash job is already running (${label}). Use !poll / !stop (or /bash poll / /bash stop).`,
    };
  }

  const commandText = request.command.trim();
  if (!commandText) return buildUsageReply();

  activeJob = {
    state: "starting",
    startedAt: Date.now(),
    command: commandText,
  };

  try {
    const foregroundMs = resolveForegroundMs(params.cfg);
    const shouldBackgroundImmediately = foregroundMs <= 0;
    const timeoutSec =
      params.cfg.tools?.exec?.timeoutSec ?? params.cfg.tools?.bash?.timeoutSec;
    const execTool = createExecTool({
      scopeKey: CHAT_BASH_SCOPE_KEY,
      allowBackground: true,
      timeoutSec,
      elevated: {
        enabled: params.elevated.enabled,
        allowed: params.elevated.allowed,
        defaultLevel: "on",
      },
    });
    const result = await execTool.execute("chat-bash", {
      command: commandText,
      background: shouldBackgroundImmediately,
      yieldMs: shouldBackgroundImmediately ? undefined : foregroundMs,
      timeout: timeoutSec,
      elevated: true,
    });

    if (result.details?.status === "running") {
      const sessionId = result.details.sessionId;
      activeJob = {
        state: "running",
        sessionId,
        startedAt: result.details.startedAt,
        command: commandText,
        watcherAttached: false,
      };
      attachActiveWatcher(sessionId);
      const snippet = formatSessionSnippet(sessionId);
      logVerbose(`Started bash session ${snippet}: ${commandText}`);
      return {
        text: `⚙️ bash started (session ${sessionId}). Still running; use !poll / !stop (or /bash poll / /bash stop).`,
      };
    }

    // Completed in foreground.
    activeJob = null;
    const exitCode =
      result.details?.status === "completed" ? result.details.exitCode : 0;
    const output =
      result.details?.status === "completed"
        ? result.details.aggregated
        : result.content
            .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
            .join("\n");
    return {
      text: [
        `⚙️ bash: ${commandText}`,
        `Exit: ${exitCode}`,
        formatOutputBlock(output || "(no output)"),
      ].join("\n"),
    };
  } catch (err) {
    activeJob = null;
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: [`⚠️ bash failed: ${commandText}`, formatOutputBlock(message)].join(
        "\n",
      ),
    };
  }
}

export function resetBashChatCommandForTests() {
  activeJob = null;
}
