import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getFinishedSession, getSession } from "../../agents/bash-process-registry.js";
import { createExecTool } from "../../agents/bash-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { isCommandFlagEnabled } from "../../config/commands.flags.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { clampInt } from "../../utils.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { buildDisabledCommandReply } from "./command-gates.js";
import { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

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

function resolveForegroundMs(cfg: OpenClawConfig): number {
  const raw = cfg.commands?.bashForegroundMs;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return DEFAULT_FOREGROUND_MS;
  }
  return clampInt(raw, 0, MAX_FOREGROUND_MS);
}

function formatSessionSnippet(sessionId: string) {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}…`;
}

function formatOutputBlock(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(no output)";
  }
  return `\`\`\`txt\n${trimmed}\n\`\`\``;
}

function parseBashRequest(raw: string): BashRequest | null {
  const trimmed = raw.trimStart();
  let restSource = "";
  if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("/bash")) {
    const match = trimmed.match(/^\/bash(?:\s*:\s*|\s+|$)([\s\S]*)$/i);
    if (!match) {
      return null;
    }
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
  if (!rest) {
    return { action: "help" };
  }
  const tokenMatch = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const token = normalizeOptionalString(tokenMatch?.[1]) ?? "";
  const remainder = normalizeOptionalString(tokenMatch?.[2]) ?? "";
  const lowered = normalizeLowercaseStringOrEmpty(token);
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
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}) {
  const source = params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body ?? "";
  const stripped = stripStructuralPrefixes(source);
  return params.isGroup
    ? stripMentions(stripped, params.ctx, params.cfg, params.agentId)
    : stripped;
}

function getScopedSession(sessionId: string) {
  const running = getSession(sessionId);
  if (running && running.scopeKey === CHAT_BASH_SCOPE_KEY) {
    return { running };
  }
  const finished = getFinishedSession(sessionId);
  if (finished && finished.scopeKey === CHAT_BASH_SCOPE_KEY) {
    return { finished };
  }
  return {};
}

function ensureActiveJobState() {
  if (!activeJob) {
    return null;
  }
  if (activeJob.state === "starting") {
    return activeJob;
  }
  const { running, finished } = getScopedSession(activeJob.sessionId);
  if (running) {
    return activeJob;
  }
  if (finished) {
    activeJob = null;
    return null;
  }
  activeJob = null;
  return null;
}

function attachActiveWatcher(sessionId: string) {
  if (!activeJob || activeJob.state !== "running") {
    return;
  }
  if (activeJob.sessionId !== sessionId) {
    return;
  }
  if (activeJob.watcherAttached) {
    return;
  }
  const { running } = getScopedSession(sessionId);
  const child = running?.child;
  if (!child) {
    return;
  }
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

export async function handleBashChatCommand(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  isGroup: boolean;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{ gate: string; key: string }>;
  };
}): Promise<ReplyPayload> {
  if (!isCommandFlagEnabled(params.cfg, "bash")) {
    return buildDisabledCommandReply({
      label: "bash",
      configKey: "bash",
      docsUrl: "https://docs.openclaw.ai/tools/slash-commands#config",
    });
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
      sessionKey: resolveRuntimePolicySessionKey({
        cfg: params.cfg,
        ctx: params.ctx,
        sessionKey: params.sessionKey,
      }),
    }).sandboxed;
    return {
      text: formatElevatedUnavailableMessage({
        runtimeSandboxed,
        failures: params.elevated.failures,
        sessionKey: params.sessionKey,
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
      normalizeOptionalString(request.sessionId) ||
      (liveJob?.state === "running" ? liveJob.sessionId : "");
    if (!sessionId) {
      return { text: "⚙️ No active bash job." };
    }
    const { running, finished } = getScopedSession(sessionId);
    if (running) {
      attachActiveWatcher(sessionId);
      const runtimeSec = Math.max(0, Math.floor((Date.now() - running.startedAt) / 1000));
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
      normalizeOptionalString(request.sessionId) ||
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
    if (!pid) {
      return {
        text: `⚠️ Unable to stop bash session ${formatSessionSnippet(sessionId)} because no process ID is available. Use !poll ${sessionId} to check whether it exits on its own.`,
      };
    }
    const { killProcessTree } = await import("../../process/kill-tree.js");
    killProcessTree(pid);
    return {
      text: `⚙️ bash stopping (session ${formatSessionSnippet(sessionId)}). Use !poll ${sessionId} to confirm exit.`,
    };
  }

  // request.action === "run"
  if (liveJob) {
    const label =
      liveJob.state === "running" ? formatSessionSnippet(liveJob.sessionId) : "starting";
    return {
      text: `⚠️ A bash job is already running (${label}). Use !poll / !stop (or /bash poll / /bash stop).`,
    };
  }

  const commandText = request.command.trim();
  if (!commandText) {
    return buildUsageReply();
  }

  activeJob = {
    state: "starting",
    startedAt: Date.now(),
    command: commandText,
  };

  try {
    const foregroundMs = resolveForegroundMs(params.cfg);
    const shouldBackgroundImmediately = foregroundMs <= 0;
    const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
    const notifyOnExit = params.cfg.tools?.exec?.notifyOnExit;
    const notifyOnExitEmptySuccess = params.cfg.tools?.exec?.notifyOnExitEmptySuccess;
    const execTool = createExecTool({
      scopeKey: CHAT_BASH_SCOPE_KEY,
      allowBackground: true,
      timeoutSec,
      sessionKey: params.sessionKey,
      mainKey: params.cfg.session?.mainKey,
      sessionScope: params.cfg.session?.scope,
      notifyOnExit,
      notifyOnExitEmptySuccess,
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
    const exitCode = result.details?.status === "completed" ? result.details.exitCode : 0;
    const output =
      result.details?.status === "completed"
        ? result.details.aggregated
        : result.content.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("\n");
    return {
      text: [
        `⚙️ bash: ${commandText}`,
        `Exit: ${exitCode}`,
        formatOutputBlock(output || "(no output)"),
      ].join("\n"),
    };
  } catch (err) {
    activeJob = null;
    const message = formatErrorMessage(err);
    return {
      text: [`⚠️ bash failed: ${commandText}`, formatOutputBlock(message)].join("\n"),
    };
  }
}
