import fs from "node:fs";

import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import {
  derivePromptTokens,
  normalizeUsage,
  type UsageLike,
} from "../agents/usage.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveMainSessionKey,
  resolveSessionTranscriptPath,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import { shortenHomePath } from "../utils.js";
import type { ElevatedLevel, ThinkLevel, VerboseLevel } from "./thinking.js";

type AgentConfig = NonNullable<ClawdbotConfig["agent"]>;

type StatusArgs = {
  agent: AgentConfig;
  workspaceDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionScope?: SessionScope;
  storePath?: string;
  groupActivation?: "mention" | "always";
  resolvedThink?: ThinkLevel;
  resolvedVerbose?: VerboseLevel;
  resolvedElevated?: ElevatedLevel;
  modelAuth?: string;
  now?: number;
  webLinked?: boolean;
  webAuthAgeMs?: number | null;
  heartbeatSeconds?: number;
};

const formatAge = (ms?: number | null) => {
  if (!ms || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

export const formatTokenCount = (value: number) => formatKTokens(value);

const formatTokens = (
  total: number | null | undefined,
  contextTokens: number | null,
) => {
  const ctx = contextTokens ?? null;
  if (total == null) {
    const ctxLabel = ctx ? formatKTokens(ctx) : "?";
    return `unknown/${ctxLabel}`;
  }
  const pct = ctx ? Math.min(999, Math.round((total / ctx) * 100)) : null;
  const totalLabel = formatKTokens(total);
  const ctxLabel = ctx ? formatKTokens(ctx) : "?";
  return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};

export const formatContextUsageShort = (
  total: number | null | undefined,
  contextTokens: number | null | undefined,
) => `Context ${formatTokens(total, contextTokens ?? null)}`;

const readUsageFromSessionLog = (
  sessionId?: string,
):
  | {
      input: number;
      output: number;
      promptTokens: number;
      total: number;
      model?: string;
    }
  | undefined => {
  // Transcripts always live at: ~/.clawdbot/sessions/<SessionId>.jsonl
  if (!sessionId) return undefined;
  const logPath = resolveSessionTranscriptPath(sessionId);
  if (!fs.existsSync(logPath)) return undefined;

  try {
    const lines = fs.readFileSync(logPath, "utf-8").split(/\n+/);
    let input = 0;
    let output = 0;
    let promptTokens = 0;
    let model: string | undefined;
    let lastUsage: ReturnType<typeof normalizeUsage> | undefined;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          message?: {
            usage?: UsageLike;
            model?: string;
          };
          usage?: UsageLike;
          model?: string;
        };
        const usageRaw = parsed.message?.usage ?? parsed.usage;
        const usage = normalizeUsage(usageRaw);
        if (usage) lastUsage = usage;
        model = parsed.message?.model ?? parsed.model ?? model;
      } catch {
        // ignore bad lines
      }
    }

    if (!lastUsage) return undefined;
    input = lastUsage.input ?? 0;
    output = lastUsage.output ?? 0;
    promptTokens =
      derivePromptTokens(lastUsage) ?? lastUsage.total ?? input + output;
    const total = lastUsage.total ?? promptTokens + output;
    if (promptTokens === 0 && total === 0) return undefined;
    return { input, output, promptTokens, total, model };
  } catch {
    return undefined;
  }
};

export function buildStatusMessage(args: StatusArgs): string {
  const now = args.now ?? Date.now();
  const entry = args.sessionEntry;
  const resolved = resolveConfiguredModelRef({
    cfg: { agent: args.agent ?? {} },
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const provider =
    entry?.modelProvider ?? resolved.provider ?? DEFAULT_PROVIDER;
  let model = entry?.model ?? resolved.model ?? DEFAULT_MODEL;
  let contextTokens =
    entry?.contextTokens ??
    args.agent?.contextTokens ??
    lookupContextTokens(model) ??
    DEFAULT_CONTEXT_TOKENS;

  let totalTokens =
    entry?.totalTokens ??
    (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);

  // Prefer prompt-size tokens from the session transcript when it looks larger
  // (cached prompt tokens are often missing from agent meta/store).
  const logUsage = readUsageFromSessionLog(entry?.sessionId);
  if (logUsage) {
    const candidate = logUsage.promptTokens || logUsage.total;
    if (!totalTokens || totalTokens === 0 || candidate > totalTokens) {
      totalTokens = candidate;
    }
    if (!model) model = logUsage.model ?? model;
    if (!contextTokens && logUsage.model) {
      contextTokens = lookupContextTokens(logUsage.model) ?? contextTokens;
    }
  }

  const thinkLevel = args.resolvedThink ?? args.agent?.thinkingDefault ?? "off";
  const verboseLevel =
    args.resolvedVerbose ?? args.agent?.verboseDefault ?? "off";
  const elevatedLevel =
    args.resolvedElevated ??
    args.sessionEntry?.elevatedLevel ??
    args.agent?.elevatedDefault ??
    "on";

  const runtime = (() => {
    const sandboxMode = args.agent?.sandbox?.mode ?? "off";
    if (sandboxMode === "off")
      return { line: "Runtime: direct", sandboxed: false };
    const sessionScope = args.sessionScope ?? "per-sender";
    const mainKey = resolveMainSessionKey({
      session: { scope: sessionScope },
    });
    const sessionKey = args.sessionKey?.trim();
    const sandboxed = sessionKey
      ? sandboxMode === "all" || sessionKey !== mainKey.trim()
      : false;
    const runtime = sandboxed ? "docker" : sessionKey ? "direct" : "unknown";
    const suffix = sandboxed ? ` • elevated ${elevatedLevel}` : "";
    return {
      line: `Runtime: ${runtime} (sandbox ${sandboxMode})${suffix}`,
      sandboxed,
    };
  })();

  const webLine = (() => {
    if (args.webLinked === false) {
      return "Web: not linked — run `clawdbot login` to scan the QR.";
    }
    const authAge = formatAge(args.webAuthAgeMs);
    const heartbeat =
      typeof args.heartbeatSeconds === "number"
        ? ` • heartbeat ${args.heartbeatSeconds}s`
        : "";
    return `Web: linked • auth refreshed ${authAge}${heartbeat}`;
  })();

  const sessionLine = [
    `Session: ${args.sessionKey ?? "unknown"}`,
    `scope ${args.sessionScope ?? "per-sender"}`,
    entry?.updatedAt
      ? `updated ${formatAge(now - entry.updatedAt)}`
      : "no activity",
    typeof entry?.compactionCount === "number"
      ? `compactions ${entry.compactionCount}`
      : undefined,
    args.storePath ? `store ${shortenHomePath(args.storePath)}` : undefined,
  ]
    .filter(Boolean)
    .join(" • ");

  const isGroupSession =
    entry?.chatType === "group" ||
    entry?.chatType === "room" ||
    Boolean(args.sessionKey?.includes(":group:")) ||
    Boolean(args.sessionKey?.includes(":channel:")) ||
    Boolean(args.sessionKey?.startsWith("group:"));
  const groupActivationLine = isGroupSession
    ? `Group activation: ${args.groupActivation ?? entry?.groupActivation ?? "mention"}`
    : undefined;

  const contextLine = `Context: ${formatTokens(
    totalTokens,
    contextTokens ?? null,
  )}${entry?.abortedLastRun ? " • last run aborted" : ""}`;

  const optionsLine = runtime.sandboxed
    ? `Options: thinking=${thinkLevel} | verbose=${verboseLevel} | elevated=${elevatedLevel}`
    : `Options: thinking=${thinkLevel} | verbose=${verboseLevel}`;

  const modelLabel = model ? `${provider}/${model}` : "unknown";

  const agentLine = `Agent: embedded pi • ${modelLabel}`;
  const authLine = args.modelAuth ? `Model auth: ${args.modelAuth}` : undefined;

  const workspaceLine = args.workspaceDir
    ? `Workspace: ${shortenHomePath(args.workspaceDir)}`
    : undefined;

  return [
    "⚙️ Status",
    webLine,
    agentLine,
    authLine,
    runtime.line,
    workspaceLine,
    contextLine,
    sessionLine,
    groupActivationLine,
    optionsLine,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildHelpMessage(): string {
  return [
    "ℹ️ Help",
    "Shortcuts: /new reset | /compact [instructions] | /restart relink",
    "Options: /think <level> | /verbose on|off | /elevated on|off | /model <id>",
  ].join("\n");
}
