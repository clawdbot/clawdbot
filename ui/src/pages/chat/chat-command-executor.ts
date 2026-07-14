/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import { formatFastModeCommandOptions } from "../../../../src/shared/fast-mode.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import {
  type ChatModelOverride,
  createChatModelOverride,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import {
  normalizeChatFastModeInput,
  resolveChatFastModeStatus,
} from "../../lib/chat/model-select-state.ts";
import {
  formatThinkingCommandOptionsForSession,
  isThinkingLevelOptionForSession,
  resolveCurrentThinkingLevel,
  resolveThinkingLevelInput,
} from "../../lib/chat/thinking.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  patchChatCommandSessionSettings as patchSession,
  selectedGlobalScope,
} from "./chat-settings-patches.ts";

type SlashCommandResult = {
  /** Markdown-formatted result to display in chat. */
  content: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?: "refresh" | "export" | "new-session" | "reset" | "stop" | "clear" | "navigate-usage";
  /** Optional session-level directive changes that the caller should mirror locally. */
  sessionPatch?: {
    modelOverride?: ChatModelOverride | null;
  };
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
  /** The command did not complete and a durable queued invocation may be retried. */
  failed?: boolean;
};

type SlashCommandContext = {
  sessions: SessionCapability;
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  defaultAgentId?: string;
  agentId?: string;
};

function normalizeVerboseLevel(raw?: string | null): "off" | "on" | "full" | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "all", "everything"].includes(key)) {
    return "full";
  }
  if (["on", "minimal", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

function isSessionDefaultDirectiveValue(raw?: string | null): boolean {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return false;
  }
  return ["default", "inherit", "inherited", "clear", "reset", "unpin"].includes(key);
}

export async function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (commandName) {
    case "help":
      return executeHelp();
    case "new":
      return { content: "Starting new session...", action: "new-session" };
    case "reset":
      return { content: "Resetting session...", action: "reset" };
    case "stop":
      return { content: "Stopping current run...", action: "stop" };
    case "clear":
      return { content: "Chat history cleared.", action: "clear" };
    case "compact":
      return await executeCompact(sessionKey, context);
    case "model":
      return await executeModel(client, sessionKey, args, context);
    case "think":
      return await executeThink(client, sessionKey, args, context);
    case "fast":
      return await executeFast(client, sessionKey, args, context);
    case "verbose":
      return await executeVerbose(client, sessionKey, args, context);
    case "export-session":
      return { content: "Exporting session...", action: "export" };
    case "usage":
      return await executeUsage(sessionKey, context);
    case "agents":
      return await executeAgents(client);
    case "steer":
      return await executeSteer(client, sessionKey, args, context);
    case "redirect":
      return await executeRedirect(client, sessionKey, args, context);
    default:
      return { content: `Unknown command: \`/${commandName}\`` };
  }
}

// ── Command Implementations ──

function executeHelp(): SlashCommandResult {
  const lines = ["**Available Commands**\n"];
  let currentCategory = "";

  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? "session";
    if (cat !== currentCategory) {
      currentCategory = cat;
      lines.push(`**${cat.charAt(0).toUpperCase() + cat.slice(1)}**`);
    }
    const argStr = cmd.args ? ` ${cmd.args}` : "";
    const local = cmd.executeLocal ? "" : " *(agent)*";
    lines.push(`\`/${cmd.name}${argStr}\` — ${cmd.description}${local}`);
  }

  lines.push("\nType `/` to open the command menu.");
  return { content: lines.join("\n") };
}

async function executeCompact(
  sessionKey: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const result = await context.sessions.compact(
      sessionKey,
      selectedGlobalScope(sessionKey, context),
    );
    if (result?.ok !== true) {
      const reason = typeof result?.reason === "string" ? result.reason.trim() : "";
      return {
        content: reason ? `Compaction failed: ${reason}` : "Compaction failed.",
        failed: true,
      };
    }
    if (result?.compacted) {
      const before = result.result?.tokensBefore;
      const after = result.result?.tokensAfter;
      const tokenSummary =
        typeof before === "number" && typeof after === "number"
          ? ` (${before.toLocaleString()} -> ${after.toLocaleString()} tokens)`
          : "";
      return { content: `Context compacted successfully${tokenSummary}.`, action: "refresh" };
    }
    if (typeof result?.reason === "string" && result.reason.trim()) {
      return { content: `Compaction skipped: ${result.reason}`, action: "refresh" };
    }
    return { content: "Compaction skipped.", action: "refresh" };
  } catch (err) {
    return { content: `Compaction failed: ${String(err)}`, failed: true };
  }
}

async function executeModel(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const modelCatalog = context.chatModelCatalog ?? context.modelCatalog;
  if (!args) {
    try {
      const [sessions, models] = await Promise.all([
        listSessions(context, selectedAgentListScope(sessionKey, context)),
        modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client),
      ]);
      const { session, defaults } = resolveCommandSessionState(context, sessionKey, sessions);
      const model = session?.model || defaults?.model || "default";
      const available = models
        .filter((entry: ModelCatalogEntry) => entry.available !== false)
        .map((entry: ModelCatalogEntry) => entry.id);
      const lines = [`**Current model:** \`${model}\``];
      if (available.length > 0) {
        lines.push(
          `**Available:** ${available
            .slice(0, 10)
            .map((m: string) => `\`${m}\``)
            .join(", ")}${available.length > 10 ? ` +${available.length - 10} more` : ""}`,
        );
      }
      return { content: lines.join("\n") };
    } catch (err) {
      return { content: `Failed to get model info: ${String(err)}`, failed: true };
    }
  }

  try {
    const requestedModel = args.trim();
    const [patched, resolvedModelCatalog] = await Promise.all([
      patchSession(context, sessionKey, {
        model: requestedModel,
      }),
      modelCatalog
        ? Promise.resolve(modelCatalog)
        : loadModelCatalog(client, { allowFailure: true }),
    ]);
    const resolvedModel = patched.resolved?.model ?? requestedModel;
    let resolvedValue = resolvePreferredServerChatModelValue(
      resolvedModel,
      patched.resolved?.modelProvider,
      resolvedModelCatalog,
    );
    const requestedOverride = createChatModelOverride(requestedModel);
    const resolvedProvider = patched.resolved?.modelProvider?.trim();
    if (
      requestedOverride?.kind === "qualified" &&
      resolvedProvider &&
      resolvedValue &&
      !resolvedValue.toLowerCase().startsWith(`${resolvedProvider.toLowerCase()}/`) &&
      requestedOverride.value.toLowerCase().endsWith(`/${resolvedModel.trim().toLowerCase()}`)
    ) {
      resolvedValue = requestedOverride.value;
    }
    return {
      content: `Model set to \`${requestedModel}\`.`,
      action: "refresh",
      sessionPatch: { modelOverride: createChatModelOverride(resolvedValue) },
    };
  } catch (err) {
    return { content: `Failed to set model: ${String(err)}`, failed: true };
  }
}

async function executeThink(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const { session, defaults, models } = await loadThinkingCommandState(
        client,
        context,
        sessionKey,
      );
      return {
        content: formatDirectiveOptions(
          `Current thinking level: ${resolveCurrentThinkingLevel(session, defaults, models)}.`,
          formatThinkingCommandOptionsForSession(session, defaults),
        ),
      };
    } catch (err) {
      return { content: `Failed to get thinking level: ${String(err)}`, failed: true };
    }
  }

  if (isSessionDefaultDirectiveValue(rawLevel)) {
    try {
      await patchSession(context, sessionKey, {
        thinkingLevel: null,
      });
      return {
        content: "Thinking level reset to default.",
        action: "refresh",
      };
    } catch (err) {
      return { content: `Failed to reset thinking level: ${String(err)}`, failed: true };
    }
  }

  try {
    const { session, defaults } = await loadCurrentSessionState(context, sessionKey);
    const level = resolveThinkingLevelInput(rawLevel, session, defaults);
    if (!level) {
      return {
        content: `Unrecognized thinking level "${rawLevel}". Valid levels: ${formatThinkingCommandOptionsForSession(session, defaults)}.`,
      };
    }
    if (!isThinkingLevelOptionForSession(session, defaults, level)) {
      return {
        content: `Unsupported thinking level "${rawLevel}" for this model. Valid levels: ${formatThinkingCommandOptionsForSession(session, defaults)}.`,
      };
    }
    await patchSession(context, sessionKey, {
      thinkingLevel: level,
    });
    return {
      content: `Thinking level set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set thinking level: ${String(err)}`, failed: true };
  }
}

async function executeVerbose(
  _client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const session = await loadCurrentSession(context, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current verbose level: ${normalizeVerboseLevel(session?.verboseLevel) ?? "off"}.`,
          "on, full, off",
        ),
      };
    } catch (err) {
      return { content: `Failed to get verbose level: ${String(err)}`, failed: true };
    }
  }

  const level = normalizeVerboseLevel(rawLevel);
  if (!level) {
    return {
      content: `Unrecognized verbose level "${rawLevel}". Valid levels: off, on, full.`,
    };
  }

  try {
    await patchSession(context, sessionKey, {
      verboseLevel: level,
    });
    return {
      content: `Verbose mode set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set verbose mode: ${String(err)}`, failed: true };
  }
}

async function executeFast(
  _client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawMode = normalizeLowercaseStringOrEmpty(args);

  if (!rawMode || rawMode === "status") {
    try {
      const session = await loadCurrentSession(context, sessionKey);
      return {
        content: formatDirectiveOptions(
          resolveChatFastModeStatus(session),
          formatFastModeCommandOptions({
            fastAutoOnSeconds: session?.fastAutoOnSeconds,
          }),
        ),
      };
    } catch (err) {
      return { content: `Failed to get fast mode: ${String(err)}`, failed: true };
    }
  }

  if (isSessionDefaultDirectiveValue(rawMode)) {
    try {
      await patchSession(context, sessionKey, {
        fastMode: null,
      });
      return {
        content: "Fast mode reset to default.",
        action: "refresh",
      };
    } catch (err) {
      return { content: `Failed to reset fast mode: ${String(err)}`, failed: true };
    }
  }

  const nextMode = normalizeChatFastModeInput(rawMode);
  if (nextMode === undefined) {
    return {
      content: `Unrecognized fast mode "${args.trim()}". Valid levels: on, off, auto, default, status.`,
    };
  }

  try {
    await patchSession(context, sessionKey, {
      fastMode: nextMode,
    });
    return {
      content:
        nextMode === "auto"
          ? "Fast mode set to auto."
          : `Fast mode ${nextMode ? "enabled" : "disabled"}.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set fast mode: ${String(err)}`, failed: true };
  }
}

async function executeUsage(
  sessionKey: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const sessions = await listSessions(context);
    const session = resolveCurrentSession(sessions, sessionKey);
    if (!session) {
      return { content: "No active session." };
    }
    const hasInputTokens = Number.isFinite(session.inputTokens);
    const hasOutputTokens = Number.isFinite(session.outputTokens);
    const input = hasInputTokens ? (session.inputTokens ?? 0) : 0;
    const output = hasOutputTokens ? (session.outputTokens ?? 0) : 0;
    const cumulativeTotal = hasInputTokens || hasOutputTokens ? input + output : null;
    const contextSnapshotTotal = Number.isFinite(session.totalTokens)
      ? (session.totalTokens ?? null)
      : cumulativeTotal;
    const totalTokensFresh = session.totalTokensFresh !== false;
    const ctx = session.contextTokens ?? 0;
    const pct =
      contextSnapshotTotal !== null && totalTokensFresh && ctx > 0
        ? Math.round((contextSnapshotTotal / ctx) * 100)
        : null;
    const totalDisplay =
      cumulativeTotal === null
        ? "n/a"
        : `${totalTokensFresh ? "" : "~"}${formatCompactTokenCount(cumulativeTotal)}`;

    const lines = [
      "**Session Usage**",
      `Input: **${formatCompactTokenCount(input)}** tokens`,
      `Output: **${formatCompactTokenCount(output)}** tokens`,
      `Total: **${totalDisplay}** tokens`,
    ];
    if (pct !== null) {
      lines.push(`Context: **${pct}%** of ${formatCompactTokenCount(ctx)}`);
    }
    if (session.model) {
      lines.push(`Model: \`${session.model}\``);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to get usage: ${String(err)}`, failed: true };
  }
}

async function executeAgents(client: GatewayBrowserClient): Promise<SlashCommandResult> {
  try {
    const result = await client.request<AgentsListResult>("agents.list", {});
    const agents = result?.agents ?? [];
    if (agents.length === 0) {
      return { content: "No agents configured." };
    }
    const lines = [`**Agents** (${agents.length})\n`];
    for (const agent of agents) {
      const isDefault = agent.id === result?.defaultId;
      const name = agent.identity?.name || agent.name || agent.id;
      const marker = isDefault ? " *(default)*" : "";
      const runtime = agent.agentRuntime?.id ? ` · runtime \`${agent.agentRuntime.id}\`` : "";
      lines.push(`- \`${agent.id}\` — ${name}${marker}${runtime}`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to list agents: ${String(err)}`, failed: true };
  }
}

function normalizeSessionKey(key?: string | null): string | undefined {
  return normalizeOptionalLowercaseString(key);
}

function selectedAgentListScope(
  sessionKey: string,
  context: SlashCommandContext,
): { agentId?: string } {
  const parsedAgentId = parseAgentSessionKey(normalizeSessionKey(sessionKey) ?? "")?.agentId;
  const agentId = parsedAgentId ?? normalizeOptionalLowercaseString(context.agentId);
  return agentId ? { agentId } : {};
}

function resolveSelectedAgentId(
  sessionKey: string,
  context: SlashCommandContext,
): string | undefined {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  return (
    parseAgentSessionKey(normalizedSessionKey ?? "")?.agentId ??
    normalizeOptionalLowercaseString(context.agentId) ??
    (normalizedSessionKey === DEFAULT_MAIN_KEY
      ? (normalizeOptionalLowercaseString(context.defaultAgentId) ?? DEFAULT_AGENT_ID)
      : undefined)
  );
}

function resolveEquivalentSessionKeys(
  currentSessionKey: string,
  currentAgentId: string | undefined,
): Set<string> {
  const keys = new Set<string>([currentSessionKey]);
  if (currentAgentId && currentAgentId !== DEFAULT_AGENT_ID) {
    const agentMainKey = `agent:${currentAgentId}:${DEFAULT_MAIN_KEY}`;
    const agentGlobalKey = `agent:${currentAgentId}:global`;
    if (currentSessionKey === agentMainKey || currentSessionKey === agentGlobalKey) {
      keys.add("global");
    }
  }
  if (currentAgentId === DEFAULT_AGENT_ID) {
    const canonicalDefaultMain = `agent:${DEFAULT_AGENT_ID}:main`;
    if (currentSessionKey === DEFAULT_MAIN_KEY) {
      keys.add(canonicalDefaultMain);
    } else if (currentSessionKey === canonicalDefaultMain) {
      keys.add(DEFAULT_MAIN_KEY);
    }
  }
  return keys;
}

function formatDirectiveOptions(text: string, options: string): string {
  return `${text}\nOptions: ${options}.`;
}

async function listSessions(
  context: SlashCommandContext,
  options?: Parameters<SessionCapability["list"]>[0],
): Promise<SessionsListResult> {
  const result = await context.sessions.list(options);
  if (!result) {
    throw new Error("Session capability is unavailable");
  }
  return result;
}

async function loadCurrentSession(
  context: SlashCommandContext,
  sessionKey: string,
): Promise<GatewaySessionRow | undefined> {
  return (await loadCurrentSessionState(context, sessionKey)).session;
}

async function loadCurrentSessionState(
  context: SlashCommandContext,
  sessionKey: string,
): Promise<{
  session: GatewaySessionRow | undefined;
  defaults: SessionsListResult["defaults"] | undefined;
}> {
  const sessions = await listSessions(context, selectedAgentListScope(sessionKey, context));
  return resolveCommandSessionState(context, sessionKey, sessions);
}

function resolveCommandSessionState(
  context: SlashCommandContext,
  sessionKey: string,
  sessions: SessionsListResult,
): {
  session: GatewaySessionRow | undefined;
  defaults: SessionsListResult["defaults"] | undefined;
} {
  const selectedAgentId = resolveSelectedAgentId(sessionKey, context);
  const defaultAgentId =
    normalizeOptionalLowercaseString(context.defaultAgentId) ?? DEFAULT_AGENT_ID;
  const cachedAgentId = normalizeOptionalLowercaseString(context.sessionsResultAgentId);
  const cachedSession =
    context.sessionsResult && selectedAgentId && cachedAgentId === selectedAgentId
      ? resolveCurrentSession(context.sessionsResult, sessionKey)
      : undefined;
  return {
    session: resolveCurrentSession(sessions, sessionKey) ?? cachedSession,
    // sessions.list scopes rows by agent, but its defaults remain global.
    defaults:
      !selectedAgentId || selectedAgentId === defaultAgentId ? sessions.defaults : undefined,
  };
}

function resolveCurrentSession(
  sessions: SessionsListResult | undefined,
  sessionKey: string,
): GatewaySessionRow | undefined {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const currentAgentId =
    parseAgentSessionKey(normalizedSessionKey ?? "")?.agentId ??
    (normalizedSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const aliases = normalizedSessionKey
    ? resolveEquivalentSessionKeys(normalizedSessionKey, currentAgentId)
    : new Set<string>();
  return sessions?.sessions?.find((session: GatewaySessionRow) => {
    const key = normalizeSessionKey(session.key);
    return key ? aliases.has(key) : false;
  });
}

async function loadThinkingCommandState(
  client: GatewayBrowserClient,
  context: SlashCommandContext,
  sessionKey: string,
) {
  const modelCatalog = context.chatModelCatalog ?? context.modelCatalog;
  const [sessions, models] = await Promise.all([
    listSessions(context, selectedAgentListScope(sessionKey, context)),
    modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client),
  ]);
  const state = resolveCommandSessionState(context, sessionKey, sessions);
  return {
    ...state,
    models,
  };
}

async function loadModelCatalog(
  client: GatewayBrowserClient,
  opts?: { allowFailure?: boolean },
): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
    });
    return result?.models ?? [];
  } catch (err) {
    if (opts?.allowFailure) {
      return [];
    }
    throw err;
  }
}

async function resolveSteerTarget(
  sessionKey: string,
  args: string,
): Promise<{ key: string; message: string } | { error: string }> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "empty" };
  }
  return {
    key: sessionKey,
    message: trimmed,
  };
}

function isActiveSteerSession(session: GatewaySessionRow | undefined): boolean {
  return Boolean(session && isSessionRunActive(session));
}

type SteerChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";

function normalizeSteerChatSendAckStatus(payload: unknown): SteerChatSendAckStatus {
  if (!payload || typeof payload !== "object") {
    return "started";
  }
  const status = (payload as Record<string, unknown>).status;
  return status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
    ? status
    : "started";
}

function formatTerminalSteerAckContent(status: SteerChatSendAckStatus): string | undefined {
  if (status === "timeout") {
    return "The active run ended before the steer message was accepted.";
  }
  if (status === "error") {
    return "Steer failed before it reached the run; try again.";
  }
  return undefined;
}

function formatTerminalRedirectAckContent(status: SteerChatSendAckStatus): string | undefined {
  if (status === "timeout") {
    return "The active run ended before the redirect message was accepted.";
  }
  if (status === "error") {
    return "Redirect failed before it reached the run; try again.";
  }
  return undefined;
}

/** Soft inject — queues a message into the active run via chat.send (deliver: false). */
async function executeSteer(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/steer <message>`" : resolved.error,
      };
    }
    const sessions =
      context.sessionsResult ??
      (await listSessions(context, selectedGlobalScope(sessionKey, context)));
    const targetSession = resolveCurrentSession(sessions, resolved.key);
    if (!isActiveSteerSession(targetSession)) {
      return {
        content: "No active run. Use the chat input or `/redirect` instead.",
      };
    }
    const ackStatus = normalizeSteerChatSendAckStatus(
      await client.request("chat.send", {
        sessionKey: resolved.key,
        ...selectedGlobalScope(resolved.key, context),
        message: resolved.message,
        deliver: false,
        idempotencyKey: generateUUID(),
      }),
    );
    const terminalAckContent = formatTerminalSteerAckContent(ackStatus);
    if (terminalAckContent) {
      return { content: terminalAckContent };
    }
    const result: SlashCommandResult = { content: "Steered." };
    if (ackStatus === "started" || ackStatus === "in_flight") {
      result.pendingCurrentRun = resolved.key === sessionKey;
    }
    return result;
  } catch (err) {
    return { content: `Failed to steer: ${String(err)}`, failed: true };
  }
}

/** Hard redirect — aborts the active run and restarts with a new message. */
async function executeRedirect(
  _client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/redirect <message>`" : resolved.error,
      };
    }
    const resp = await context.sessions.steer(
      resolved.key,
      resolved.message,
      selectedGlobalScope(resolved.key, context),
    );
    const ackStatus = normalizeSteerChatSendAckStatus(resp);
    const terminalAckContent = formatTerminalRedirectAckContent(ackStatus);
    if (terminalAckContent) {
      return { content: terminalAckContent };
    }
    const runId = typeof resp?.runId === "string" ? resp.runId : undefined;
    return {
      content: "Redirected.",
      ...(ackStatus === "started" || ackStatus === "in_flight" ? { trackRunId: runId } : {}),
    };
  } catch (err) {
    return { content: `Failed to redirect: ${String(err)}`, failed: true };
  }
}
