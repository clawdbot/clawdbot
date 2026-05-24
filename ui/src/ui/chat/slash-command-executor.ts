/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import {
  createChatModelOverride,
  resolvePreferredServerChatModelValue,
} from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { DEFAULT_AGENT_ID, DEFAULT_MAIN_KEY, parseAgentSessionKey } from "../session-key.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../string-coerce.ts";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../thinking.ts";
import type {
  AgentsListResult,
  ChatModelOverride,
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  ModelCatalogEntry,
  SessionsListResult,
  SessionsPatchResult,
} from "../types.ts";
import { generateUUID } from "../uuid.ts";
import { SLASH_COMMANDS } from "./slash-commands.ts";

export type SlashCommandResult = {
  /** Markdown-formatted result to display in chat. */
  content: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?:
    | "refresh"
    | "export"
    | "new-session"
    | "reset"
    | "stop"
    | "clear"
    | "toggle-focus"
    | "navigate-usage";
  /** Optional session-level directive changes that the caller should mirror locally. */
  sessionPatch?: {
    modelOverride?: ChatModelOverride | null;
  };
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
};

export type SlashCommandContext = {
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
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
  context: SlashCommandContext = {},
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
    case "focus":
      return { content: "Toggled focus mode.", action: "toggle-focus" };
    case "compact":
      return await executeCompact(client, sessionKey);
    case "model":
      return await executeModel(client, sessionKey, args, context);
    case "think":
      return await executeThink(client, sessionKey, args);
    case "fast":
      return await executeFast(client, sessionKey, args);
    case "verbose":
      return await executeVerbose(client, sessionKey, args);
    case "export-session":
      return { content: "Exporting session...", action: "export" };
    case "usage":
      return await executeUsage(client, sessionKey);
    case "agents":
      return await executeAgents(client);
    case "steer":
      return await executeSteer(client, sessionKey, args, context);
    case "redirect":
      return await executeRedirect(client, sessionKey, args);
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
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const result = await client.request<{
      compacted?: boolean;
      reason?: string;
      result?: { tokensBefore?: number; tokensAfter?: number };
    }>("sessions.compact", { key: sessionKey });
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
    return { content: `Compaction failed: ${String(err)}` };
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
        client.request<SessionsListResult>("sessions.list", {}),
        modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client),
      ]);
      const session = resolveCurrentSession(sessions, sessionKey);
      const model = session?.model || sessions?.defaults?.model || "default";
      const available = models.map((m: ModelCatalogEntry) => m.id);
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
      return { content: `Failed to get model info: ${String(err)}` };
    }
  }

  try {
    const requestedModel = args.trim();
    const [patched, resolvedModelCatalog] = await Promise.all([
      client.request<SessionsPatchResult>("sessions.patch", {
        key: sessionKey,
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
    return { content: `Failed to set model: ${String(err)}` };
  }
}

async function executeThink(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const { session, defaults, models } = await loadThinkingCommandState(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current thinking level: ${resolveCurrentThinkingLevel(session, defaults, models)}.`,
          formatThinkingCommandOptionsForSession(session, defaults),
        ),
      };
    } catch (err) {
      return { content: `Failed to get thinking level: ${String(err)}` };
    }
  }

  if (isSessionDefaultDirectiveValue(rawLevel)) {
    try {
      await client.request("sessions.patch", { key: sessionKey, thinkingLevel: null });
      return {
        content: "Thinking level reset to default.",
        action: "refresh",
      };
    } catch (err) {
      return { content: `Failed to reset thinking level: ${String(err)}` };
    }
  }

  try {
    const { session, defaults } = await loadCurrentSessionState(client, sessionKey);
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
    await client.request("sessions.patch", { key: sessionKey, thinkingLevel: level });
    return {
      content: `Thinking level set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set thinking level: ${String(err)}` };
  }
}

async function executeVerbose(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const session = await loadCurrentSession(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current verbose level: ${normalizeVerboseLevel(session?.verboseLevel) ?? "off"}.`,
          "on, full, off",
        ),
      };
    } catch (err) {
      return { content: `Failed to get verbose level: ${String(err)}` };
    }
  }

  const level = normalizeVerboseLevel(rawLevel);
  if (!level) {
    return {
      content: `Unrecognized verbose level "${rawLevel}". Valid levels: off, on, full.`,
    };
  }

  try {
    await client.request("sessions.patch", { key: sessionKey, verboseLevel: level });
    return {
      content: `Verbose mode set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set verbose mode: ${String(err)}` };
  }
}

async function executeFast(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawMode = normalizeLowercaseStringOrEmpty(args);

  if (!rawMode || rawMode === "status") {
    try {
      const session = await loadCurrentSession(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current fast mode: ${resolveCurrentFastMode(session)}.`,
          "status, on, off, default",
        ),
      };
    } catch (err) {
      return { content: `Failed to get fast mode: ${String(err)}` };
    }
  }

  if (isSessionDefaultDirectiveValue(rawMode)) {
    try {
      await client.request("sessions.patch", { key: sessionKey, fastMode: null });
      return {
        content: "Fast mode reset to default.",
        action: "refresh",
      };
    } catch (err) {
      return { content: `Failed to reset fast mode: ${String(err)}` };
    }
  }

  if (rawMode !== "on" && rawMode !== "off") {
    return {
      content: `Unrecognized fast mode "${args.trim()}". Valid levels: status, on, off, default.`,
    };
  }

  try {
    await client.request("sessions.patch", { key: sessionKey, fastMode: rawMode === "on" });
    return {
      content: `Fast mode ${rawMode === "on" ? "enabled" : "disabled"}.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set fast mode: ${String(err)}` };
  }
}

async function executeUsage(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
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
        : `${totalTokensFresh ? "" : "~"}${fmtTokens(cumulativeTotal)}`;

    const lines = [
      "**Session Usage**",
      `Input: **${fmtTokens(input)}** tokens`,
      `Output: **${fmtTokens(output)}** tokens`,
      `Total: **${totalDisplay}** tokens`,
    ];
    if (pct !== null) {
      lines.push(`Context: **${pct}%** of ${fmtTokens(ctx)}`);
    }
    if (session.model) {
      lines.push(`Model: \`${session.model}\``);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to get usage: ${String(err)}` };
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
    return { content: `Failed to list agents: ${String(err)}` };
  }
}

function normalizeSessionKey(key?: string | null): string | undefined {
  return normalizeOptionalLowercaseString(key);
}

function resolveEquivalentSessionKeys(
  currentSessionKey: string,
  currentAgentId: string | undefined,
): Set<string> {
  const keys = new Set<string>([currentSessionKey]);
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

function formatThinkingOptionsForSession(
  session: GatewaySessionRow | undefined,
  defaults?: SessionsListResult["defaults"],
  separator = ", ",
): string {
  return resolveThinkingLevelOptionsForSession(session, defaults)
    .map((level) => level.label)
    .join(separator);
}

function formatThinkingCommandOptionsForSession(
  session: GatewaySessionRow | undefined,
  defaults?: SessionsListResult["defaults"],
): string {
  const options = formatThinkingOptionsForSession(session, defaults);
  return options.split(", ").includes("default") ? options : `default, ${options}`;
}

function resolveThinkingLevelInput(
  rawLevel: string,
  session: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): string | undefined {
  const normalized = normalizeThinkLevel(rawLevel);
  if (normalized) {
    return normalized;
  }
  const rawKey = normalizeLowercaseStringOrEmpty(rawLevel);
  return resolveThinkingLevelOptionsForSession(session, defaults)
    .map((option) => ({
      id: normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id),
      label: normalizeLowercaseStringOrEmpty(option.label),
    }))
    .find((option) => option.id === rawKey || option.label === rawKey)?.id;
}

function isThinkingLevelOptionForSession(
  session: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  level: string,
): boolean {
  return resolveThinkingLevelOptionsForSession(session, defaults).some((option) => {
    const id = normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id);
    return id === level || normalizeThinkLevel(option.label) === level;
  });
}

function resolveThinkingLevelOptionsForSession(
  session: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): GatewayThinkingLevelOption[] {
  if (session?.thinkingLevels?.length) {
    return session.thinkingLevels;
  }
  const sessionModelMatchesDefaults =
    (!session?.modelProvider || session.modelProvider === defaults?.modelProvider) &&
    (!session?.model || session.model === defaults?.model);
  if (sessionModelMatchesDefaults && defaults?.thinkingLevels?.length) {
    return defaults.thinkingLevels;
  }
  const labels =
    (session?.thinkingOptions?.length ? session.thinkingOptions : null) ??
    (sessionModelMatchesDefaults && defaults?.thinkingOptions?.length
      ? defaults.thinkingOptions
      : null) ??
    formatThinkingLevels(
      session?.modelProvider ?? defaults?.modelProvider,
      session?.model ?? defaults?.model,
    ).split(/\s*,\s*/);
  return labels.filter(Boolean).map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

async function loadCurrentSession(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<GatewaySessionRow | undefined> {
  return (await loadCurrentSessionState(client, sessionKey)).session;
}

async function loadCurrentSessionState(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<{
  session: GatewaySessionRow | undefined;
  defaults: SessionsListResult["defaults"] | undefined;
}> {
  const sessions = await client.request<SessionsListResult>("sessions.list", {});
  return {
    session: resolveCurrentSession(sessions, sessionKey),
    defaults: sessions?.defaults,
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

async function loadThinkingCommandState(client: GatewayBrowserClient, sessionKey: string) {
  const [sessions, models] = await Promise.all([
    client.request<SessionsListResult>("sessions.list", {}),
    loadModelCatalog(client),
  ]);
  return {
    session: resolveCurrentSession(sessions, sessionKey),
    defaults: sessions?.defaults,
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

function resolveCurrentThinkingLevel(
  session: GatewaySessionRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  models: ModelCatalogEntry[],
): string {
  const persisted = normalizeThinkLevel(session?.thinkingLevel);
  if (persisted) {
    return (
      resolveThinkingLevelOptionsForSession(session, defaults).find(
        (level) => normalizeThinkLevel(level.id) === persisted,
      )?.label ?? persisted
    );
  }
  if (session?.thinkingDefault) {
    return session.thinkingDefault;
  }
  if (defaults?.thinkingDefault) {
    return defaults.thinkingDefault;
  }
  const provider = session?.modelProvider ?? defaults?.modelProvider;
  const model = session?.model ?? defaults?.model;
  if (!provider || !model) {
    return "off";
  }
  return resolveThinkingDefaultForModel({
    provider,
    model,
    catalog: models,
  });
}

function resolveCurrentFastMode(session: GatewaySessionRow | undefined): "on" | "off" {
  return session?.fastMode === true ? "on" : "off";
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
  return session?.status === "running" && session.endedAt == null;
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
      context.sessionsResult ?? (await client.request<SessionsListResult>("sessions.list", {}));
    const targetSession = resolveCurrentSession(sessions, resolved.key);
    if (!isActiveSteerSession(targetSession)) {
      return {
        content: "No active run. Use the chat input or `/redirect` instead.",
      };
    }
    await client.request("chat.send", {
      sessionKey: resolved.key,
      message: resolved.message,
      deliver: false,
      idempotencyKey: generateUUID(),
    });
    return {
      content: "Steered.",
      pendingCurrentRun: resolved.key === sessionKey,
    };
  } catch (err) {
    return { content: `Failed to steer: ${String(err)}` };
  }
}

/** Hard redirect — aborts the active run and restarts with a new message. */
async function executeRedirect(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/redirect <message>`" : resolved.error,
      };
    }
    const resp = await client.request<{ runId?: string }>("sessions.steer", {
      key: resolved.key,
      message: resolved.message,
    });
    const runId = typeof resp?.runId === "string" ? resp.runId : undefined;
    return {
      content: "Redirected.",
      trackRunId: runId,
    };
  } catch (err) {
    return { content: `Failed to redirect: ${String(err)}` };
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
