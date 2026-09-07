import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
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
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { patchChatCommandSessionSettings, selectedGlobalScope } from "./chat-settings-patches.ts";

type SlashCommandResult = {
  /** Markdown-formatted result to display in chat. */
  content?: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?: "refresh" | "export" | "new-session" | "reset" | "stop" | "clear" | "navigate-usage";
  /** Model-dependent tools need refreshing after a confirmed selection. */
  modelChanged?: boolean;
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
  /** The command did not complete and a durable queued invocation may be retried. */
  failed?: boolean;
};

type SlashCommandContext = {
  sessions: SessionCapability;
  sessionAccessSnapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">;
  readSessionAccessSnapshot?: () => Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">;
  isCurrent?: () => boolean;
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
  defaultAgentId?: string;
  agentId?: string;
  ownsModelOverride?: () => boolean;
};

function assertCurrentSlashCommand(context: SlashCommandContext): void {
  if (context.isCurrent?.() === false) {
    throw new Error("The Gateway connection changed. Retry the command.");
  }
}

function requireSessionMutationAccess(
  context: SlashCommandContext,
  request: Parameters<typeof readSessionMethodAccess>[1],
): void {
  assertCurrentSlashCommand(context);
  const access = readSessionMethodAccess(
    context.readSessionAccessSnapshot?.() ?? context.sessionAccessSnapshot,
    request,
  );
  if (!access.allowed) {
    throw new Error(access.reason);
  }
}

async function patchSession(
  context: SlashCommandContext,
  sessionKey: string,
  patch: Parameters<typeof patchChatCommandSessionSettings>[2],
  options?: Parameters<typeof patchChatCommandSessionSettings>[3],
) {
  const params = {
    key: sessionKey,
    ...selectedGlobalScope(sessionKey, context),
    ...patch,
  };
  requireSessionMutationAccess(context, {
    method: "sessions.patch",
    params,
  });
  return await patchChatCommandSessionSettings(context, sessionKey, patch, options);
}

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
      return { content: t("chat.commandResults.startingNewThread"), action: "new-session" };
    case "reset":
      return { content: t("chat.commandResults.resettingThread"), action: "reset" };
    case "stop":
      return { content: t("chat.commandResults.stoppingCurrentRun"), action: "stop" };
    case "clear":
      return { content: t("chat.commandResults.chatHistoryCleared"), action: "clear" };
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
      return { content: t("chat.commandResults.exportingThread"), action: "export" };
    case "usage":
      return await executeUsage(sessionKey, context);
    case "agents":
      return await executeAgents(client);
    case "steer":
      return await executeSteer(client, sessionKey, args, context);
    case "redirect":
      return await executeRedirect(client, sessionKey, args, context);
    default:
      return {
        content: t("chat.commandResults.unknownCommand", { command: `/${commandName}` }),
      };
  }
}

// ── Command Implementations ──

function executeHelp(): SlashCommandResult {
  const lines = [`**${t("chat.commandResults.help.availableCommands")}**\n`];
  let currentCategory = "";

  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? "session";
    if (cat !== currentCategory) {
      currentCategory = cat;
      lines.push(`**${getSlashCommandCategoryLabel(cat)}**`);
    }
    const argStr = cmd.args ? ` ${cmd.args}` : "";
    const local = cmd.executeLocal ? "" : ` *(${t("chat.commandResults.help.agentCommand")})*`;
    lines.push(`\`/${cmd.name}${argStr}\` — ${getSlashCommandDescription(cmd)}${local}`);
  }

  lines.push(`\n${t("chat.commandResults.help.openMenu")}`);
  return { content: lines.join("\n") };
}

async function executeCompact(
  sessionKey: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const options = selectedGlobalScope(sessionKey, context);
    requireSessionMutationAccess(context, {
      method: "sessions.compact",
      requiredScope: "operator.admin",
    });
    const result = await context.sessions.compact(sessionKey, options);
    if (result?.ok !== true) {
      const reason = typeof result?.reason === "string" ? formatUiExternalText(result.reason) : "";
      return {
        content: reason
          ? t("chat.commandResults.compaction.failedWithReason", { reason })
          : t("chat.commandResults.compaction.failed"),
        failed: true,
      };
    }
    if (result?.compacted) {
      return {
        action: "refresh",
      };
    }
    if (typeof result?.reason === "string" && result.reason.trim()) {
      return {
        content: t("chat.commandResults.compaction.skippedWithReason", {
          reason: formatUiExternalText(result.reason),
        }),
        action: "refresh",
      };
    }
    return { content: t("chat.commandResults.compaction.skipped"), action: "refresh" };
  } catch (err) {
    return {
      content: t("chat.commandResults.compaction.failedWithReason", { reason: formatUiError(err) }),
      failed: true,
    };
  }
}

async function executeModel(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const modelCatalog = context.chatModelCatalog ?? context.modelCatalog;
  const agentId = resolveSelectedAgentId(sessionKey, context);
  if (!args) {
    try {
      const [sessions, models] = await Promise.all([
        listSessions(context, selectedAgentListScope(sessionKey, context)),
        modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client, agentId),
      ]);
      const { session, defaults } = resolveCommandSessionState(context, sessionKey, sessions);
      const model = session?.model || defaults?.model || "default";
      const available = models
        .filter((entry: ModelCatalogEntry) => entry.available !== false)
        .map((entry: ModelCatalogEntry) => entry.id);
      const lines = [t("chat.commandResults.model.current", { model: `\`${model}\`` })];
      if (available.length > 0) {
        const remaining =
          available.length > 10
            ? t("chat.commandResults.model.more", { count: String(available.length - 10) })
            : "";
        lines.push(
          `${t("chat.commandResults.model.available", {
            models: available
              .slice(0, 10)
              .map((m: string) => `\`${m}\``)
              .join(", "),
          })}${remaining}`,
        );
      }
      return { content: lines.join("\n") };
    } catch (err) {
      return {
        content: t("chat.commandResults.model.getFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  try {
    const requestedModel = args.trim();
    await patchSession(
      context,
      sessionKey,
      {
        model: requestedModel,
      },
      {
        ownsModelOverride: context.ownsModelOverride,
      },
    );
    return {
      content: t("chat.commandResults.model.set", { model: `\`${requestedModel}\`` }),
      action: "refresh",
      modelChanged: true,
    };
  } catch (err) {
    return {
      content: t("chat.commandResults.model.setFailed", { error: formatUiError(err) }),
      failed: true,
    };
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
          t("chat.commandResults.thinking.current", {
            level: resolveCurrentThinkingLevel(session, defaults, models),
          }),
          formatThinkingCommandOptionsForSession(session, defaults, models),
        ),
      };
    } catch (err) {
      return {
        content: t("chat.commandResults.thinking.getFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  if (isSessionDefaultDirectiveValue(rawLevel)) {
    try {
      await patchSession(context, sessionKey, {
        thinkingLevel: null,
      });
      return {
        content: t("chat.commandResults.thinking.reset"),
        action: "refresh",
      };
    } catch (err) {
      return {
        content: t("chat.commandResults.thinking.resetFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  try {
    const { session, defaults } = await loadCurrentSessionState(context, sessionKey);
    const modelCatalog = context.chatModelCatalog ?? context.modelCatalog ?? [];
    const level = resolveThinkingLevelInput(rawLevel, session, defaults, modelCatalog);
    if (!level) {
      return {
        content: t("chat.commandResults.thinking.unrecognized", {
          level: rawLevel,
          options: formatThinkingCommandOptionsForSession(session, defaults, modelCatalog),
        }),
      };
    }
    if (!isThinkingLevelOptionForSession(session, defaults, level, modelCatalog)) {
      return {
        content: t("chat.commandResults.thinking.unsupported", {
          level: rawLevel,
          options: formatThinkingCommandOptionsForSession(session, defaults, modelCatalog),
        }),
      };
    }
    await patchSession(context, sessionKey, {
      thinkingLevel: level,
    });
    return {
      content: t("chat.commandResults.thinking.set", { level: `**${level}**` }),
      action: "refresh",
    };
  } catch (err) {
    return {
      content: t("chat.commandResults.thinking.setFailed", { error: formatUiError(err) }),
      failed: true,
    };
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
          t("chat.commandResults.verbose.current", {
            level: normalizeVerboseLevel(session?.verboseLevel) ?? "off",
          }),
          "on, full, off",
        ),
      };
    } catch (err) {
      return {
        content: t("chat.commandResults.verbose.getFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  const level = normalizeVerboseLevel(rawLevel);
  if (!level) {
    return {
      content: t("chat.commandResults.verbose.unrecognized", { level: rawLevel }),
    };
  }

  try {
    await patchSession(context, sessionKey, {
      verboseLevel: level,
    });
    return {
      content: t("chat.commandResults.verbose.set", { level: `**${level}**` }),
      action: "refresh",
    };
  } catch (err) {
    return {
      content: t("chat.commandResults.verbose.setFailed", { error: formatUiError(err) }),
      failed: true,
    };
  }
}

function formatFastModeOptions(session: GatewaySessionRow | undefined): string {
  return t("chat.commandResults.fast.options", {
    seconds: String(session?.fastAutoOnSeconds ?? 60),
  });
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
          formatFastModeOptions(session),
        ),
      };
    } catch (err) {
      return {
        content: t("chat.commandResults.fast.getFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  if (isSessionDefaultDirectiveValue(rawMode)) {
    try {
      await patchSession(context, sessionKey, {
        fastMode: null,
      });
      return {
        content: t("chat.commandResults.fast.reset"),
        action: "refresh",
      };
    } catch (err) {
      return {
        content: t("chat.commandResults.fast.resetFailed", { error: formatUiError(err) }),
        failed: true,
      };
    }
  }

  const nextMode = normalizeChatFastModeInput(rawMode);
  if (nextMode === undefined) {
    return {
      content: t("chat.commandResults.fast.unrecognized", { mode: args.trim() }),
    };
  }

  try {
    await patchSession(context, sessionKey, {
      fastMode: nextMode,
    });
    return {
      content:
        nextMode === "auto"
          ? t("chat.commandResults.fast.setAuto")
          : t(nextMode ? "chat.commandResults.fast.enabled" : "chat.commandResults.fast.disabled"),
      action: "refresh",
    };
  } catch (err) {
    return {
      content: t("chat.commandResults.fast.setFailed", { error: formatUiError(err) }),
      failed: true,
    };
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
      return { content: t("chat.commandResults.usage.noActiveThread") };
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
        ? t("chat.commandResults.usage.notAvailable")
        : `${totalTokensFresh ? "" : "~"}${formatCompactTokenCount(cumulativeTotal)}`;

    const lines = [
      `**${t("chat.commandResults.usage.title")}**`,
      t("chat.commandResults.usage.inputTokens", {
        count: `**${formatCompactTokenCount(input)}**`,
      }),
      t("chat.commandResults.usage.outputTokens", {
        count: `**${formatCompactTokenCount(output)}**`,
      }),
      t("chat.commandResults.usage.totalTokens", { count: `**${totalDisplay}**` }),
    ];
    if (pct !== null) {
      lines.push(
        t("chat.commandResults.usage.context", {
          percent: `**${pct}%**`,
          total: formatCompactTokenCount(ctx),
        }),
      );
    }
    if (session.model) {
      lines.push(t("chat.commandResults.usage.model", { model: `\`${session.model}\`` }));
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return {
      content: t("chat.commandResults.usage.failed", { error: formatUiError(err) }),
      failed: true,
    };
  }
}

async function executeAgents(client: GatewayBrowserClient): Promise<SlashCommandResult> {
  try {
    const result = await client.request<AgentsListResult>("agents.list", {});
    const agents = result?.agents ?? [];
    if (agents.length === 0) {
      return { content: t("chat.commandResults.agents.none") };
    }
    const lines = [t("chat.commandResults.agents.title", { count: String(agents.length) }), ""];
    for (const agent of agents) {
      const isDefault = agent.id === result?.defaultId;
      const name = agent.identity?.name || agent.name || agent.id;
      const marker = isDefault ? ` *(${t("chat.commandResults.agents.default")})*` : "";
      const runtime = agent.agentRuntime?.id
        ? t("chat.commandResults.agents.runtime", { runtime: `\`${agent.agentRuntime.id}\`` })
        : "";
      lines.push(`- \`${agent.id}\` — ${name}${marker}${runtime}`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return {
      content: t("chat.commandResults.agents.failed", { error: formatUiError(err) }),
      failed: true,
    };
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
  return `${text}\n${t("chat.commandResults.options", { options })}`;
}

async function listSessions(
  context: SlashCommandContext,
  options?: Parameters<SessionCapability["list"]>[0],
): Promise<SessionsListResult> {
  const result = await context.sessions.list(options);
  if (!result) {
    throw new Error(t("chat.commandResults.sessionUnavailable"));
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
  const agentId = resolveSelectedAgentId(sessionKey, context);
  const [sessions, models] = await Promise.all([
    listSessions(context, selectedAgentListScope(sessionKey, context)),
    modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client, agentId),
  ]);
  const state = resolveCommandSessionState(context, sessionKey, sessions);
  return {
    ...state,
    models,
  };
}

async function loadModelCatalog(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<ModelCatalogEntry[]> {
  if (!agentId) {
    return [];
  }
  const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
    agentId,
    view: "configured",
  });
  return result?.models ?? [];
}

function resolveCommandMessage(
  sessionKey: string,
  args: string,
): { key: string; message: string } | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "empty" };
  }
  return {
    key: sessionKey,
    message: trimmed,
  };
}

type SteerChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";
type SteerChatSendAck = { runId?: unknown; status?: unknown };

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
    return t("chat.commandResults.steer.timeout");
  }
  if (status === "error") {
    return t("chat.commandResults.steer.failed");
  }
  return undefined;
}

function formatTerminalRedirectAckContent(status: SteerChatSendAckStatus): string | undefined {
  if (status === "timeout") {
    return t("chat.commandResults.redirect.timeout");
  }
  if (status === "error") {
    return t("chat.commandResults.redirect.failed");
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
    const resolved = resolveCommandMessage(sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? t("chat.commandResults.steer.usage") : resolved.error,
      };
    }
    assertCurrentSlashCommand(context);
    const ackStatus = normalizeSteerChatSendAckStatus(
      await client.request("chat.send", {
        sessionKey: resolved.key,
        ...selectedGlobalScope(resolved.key, context),
        message: resolved.message,
        deliver: false,
        queueMode: "steer",
        idempotencyKey: generateUUID(),
      }),
    );
    const terminalAckContent = formatTerminalSteerAckContent(ackStatus);
    if (terminalAckContent) {
      return { content: terminalAckContent, failed: true };
    }
    const result: SlashCommandResult = { content: t("chat.commandResults.steer.succeeded") };
    if (ackStatus === "started" || ackStatus === "in_flight") {
      result.pendingCurrentRun = resolved.key === sessionKey;
    }
    return result;
  } catch (err) {
    return {
      content: t("chat.commandResults.steer.requestFailed", { error: formatUiError(err) }),
      failed: true,
    };
  }
}

/** Hard redirect — aborts the active run and restarts with a new message. */
async function executeRedirect(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const resolved = resolveCommandMessage(sessionKey, args);
    if ("error" in resolved) {
      return {
        content:
          resolved.error === "empty" ? t("chat.commandResults.redirect.usage") : resolved.error,
      };
    }
    assertCurrentSlashCommand(context);
    const resp = await client.request<SteerChatSendAck>("chat.send", {
      sessionKey: resolved.key,
      ...selectedGlobalScope(resolved.key, context),
      message: resolved.message,
      queueMode: "interrupt",
      idempotencyKey: generateUUID(),
    });
    const ackStatus = normalizeSteerChatSendAckStatus(resp);
    const terminalAckContent = formatTerminalRedirectAckContent(ackStatus);
    if (terminalAckContent) {
      return { content: terminalAckContent, failed: true };
    }
    const runId = typeof resp?.runId === "string" ? resp.runId : undefined;
    return {
      content: t("chat.commandResults.redirect.succeeded"),
      ...(ackStatus === "started" || ackStatus === "in_flight" ? { trackRunId: runId } : {}),
    };
  } catch (err) {
    return {
      content: t("chat.commandResults.redirect.requestFailed", { error: formatUiError(err) }),
      failed: true,
    };
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
