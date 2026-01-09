import crypto from "node:crypto";
import os from "node:os";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import {
  buildBootstrapContextFiles,
  type EmbeddedContextFile,
} from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { applySoulEvilOverride } from "./soul-evil.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const log = createSubsystemLogger("agent/claude-cli");
const CLAUDE_CLI_QUEUE_KEY = "global";
const CLAUDE_CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

function enqueueClaudeCliRun<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = CLAUDE_CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained.finally(() => {
    if (CLAUDE_CLI_RUN_QUEUE.get(key) === tracked) {
      CLAUDE_CLI_RUN_QUEUE.delete(key);
    }
  });
  CLAUDE_CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

type ClaudeCliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type ClaudeCliOutput = {
  text: string;
  sessionId?: string;
  usage?: ClaudeCliUsage;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeClaudeSessionId(raw?: string): string {
  const trimmed = raw?.trim();
  if (trimmed && UUID_RE.test(trimmed)) return trimmed;
  return crypto.randomUUID();
}

function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(
        new Date(),
      );
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

function formatUserTime(date: Date, timeZone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (
      !map.weekday ||
      !map.year ||
      !map.month ||
      !map.day ||
      !map.hour ||
      !map.minute
    ) {
      return undefined;
    }
    return `${map.weekday} ${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

function buildModelAliasLines(cfg?: ClawdbotConfig) {
  const models = cfg?.agent?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) continue;
    const alias = String(
      (entryRaw as { alias?: string } | undefined)?.alias ?? "",
    ).trim();
    if (!alias) continue;
    entries.push({ alias, model });
  }
  return entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: ClawdbotConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  modelDisplay: string;
}) {
  const userTimezone = resolveUserTimezone(params.config?.agent?.userTimezone);
  const userTime = formatUserTime(new Date(), userTimezone);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: resolveHeartbeatPrompt(
      params.config?.agent?.heartbeat?.prompt,
    ),
    runtimeInfo: {
      host: "clawdbot",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
    },
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    contextFiles: params.contextFiles,
  });
}

function normalizeClaudeCliModel(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "opus";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("opus")) return "opus";
  if (lower.startsWith("sonnet")) return "sonnet";
  if (lower.startsWith("haiku")) return "haiku";
  return trimmed;
}

function toUsage(raw: Record<string, unknown>): ClaudeCliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0
      ? (raw[key] as number)
      : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead = pick("cache_read_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total)
    return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) return collectText(value.message);
  return "";
}

function parseClaudeCliJson(raw: string): ClaudeCliOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const sessionId =
    (typeof parsed.session_id === "string" && parsed.session_id) ||
    (typeof parsed.sessionId === "string" && parsed.sessionId) ||
    (typeof parsed.conversation_id === "string" && parsed.conversation_id) ||
    undefined;
  const usage = isRecord(parsed.usage) ? toUsage(parsed.usage) : undefined;
  const text =
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed);
  return { text: text.trim(), sessionId, usage };
}

async function runClaudeCliOnce(params: {
  prompt: string;
  workspaceDir: string;
  modelId: string;
  systemPrompt: string;
  timeoutMs: number;
  sessionId: string;
}): Promise<ClaudeCliOutput> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    normalizeClaudeCliModel(params.modelId),
    "--append-system-prompt",
    params.systemPrompt,
    "--dangerously-skip-permissions",
    "--session-id",
    params.sessionId,
  ];
  args.push(params.prompt);

  log.info(
    `claude-cli exec: model=${normalizeClaudeCliModel(params.modelId)} promptChars=${params.prompt.length} systemPromptChars=${params.systemPrompt.length}`,
  );
  if (process.env.CLAWDBOT_CLAUDE_CLI_LOG_OUTPUT === "1") {
    const logArgs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--append-system-prompt") {
        logArgs.push(arg, `<systemPrompt:${params.systemPrompt.length} chars>`);
        i += 1;
        continue;
      }
      if (arg === "--session-id") {
        logArgs.push(arg, args[i + 1] ?? "");
        i += 1;
        continue;
      }
      logArgs.push(arg);
    }
    const promptIndex = logArgs.indexOf(params.prompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.prompt.length} chars>`;
    }
    log.info(`claude-cli argv: claude ${logArgs.join(" ")}`);
  }

  const result = await runCommandWithTimeout(["claude", ...args], {
    timeoutMs: params.timeoutMs,
    cwd: params.workspaceDir,
    env: (() => {
      const next = { ...process.env };
      delete next.ANTHROPIC_API_KEY;
      return next;
    })(),
  });
  if (process.env.CLAWDBOT_CLAUDE_CLI_LOG_OUTPUT === "1") {
    const stdoutDump = result.stdout.trim();
    const stderrDump = result.stderr.trim();
    if (stdoutDump) {
      log.info(`claude-cli stdout:\n${stdoutDump}`);
    }
    if (stderrDump) {
      log.info(`claude-cli stderr:\n${stderrDump}`);
    }
  }
  const stdout = result.stdout.trim();
  const logOutputText = process.env.CLAWDBOT_CLAUDE_CLI_LOG_OUTPUT === "1";
  if (shouldLogVerbose()) {
    if (stdout) {
      log.debug(`claude-cli stdout:\n${stdout}`);
    }
    if (result.stderr.trim()) {
      log.debug(`claude-cli stderr:\n${result.stderr.trim()}`);
    }
  }
  if (result.code !== 0) {
    const err = result.stderr.trim() || stdout || "Claude CLI failed.";
    throw new Error(err);
  }
  const parsed = parseClaudeCliJson(stdout);
  const output = parsed ?? { text: stdout };
  if (logOutputText) {
    const text = output.text?.trim();
    if (text) {
      log.info(`claude-cli output:\n${text}`);
    }
  }
  return output;
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdbotConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const modelId = (params.model ?? "opus").trim() || "opus";
  const modelDisplay = `${params.provider ?? "claude-cli"}/${modelId}`;

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const bootstrapFiles = await loadWorkspaceBootstrapFiles(workspaceDir);
  const resolvedBootstrapFiles = await applySoulEvilOverride({
    files: bootstrapFiles,
    workspaceDir,
    config: params.config,
    log,
  });
  const contextFiles = buildBootstrapContextFiles(resolvedBootstrapFiles);
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    tools: [],
    contextFiles,
    modelDisplay,
  });

  const claudeSessionId = normalizeClaudeSessionId(params.claudeSessionId);
  const output = await enqueueClaudeCliRun(CLAUDE_CLI_QUEUE_KEY, () =>
    runClaudeCliOnce({
      prompt: params.prompt,
      workspaceDir,
      modelId,
      systemPrompt,
      timeoutMs: params.timeoutMs,
      sessionId: claudeSessionId,
    }),
  );

  const text = output.text?.trim();
  const payloads = text ? [{ text }] : undefined;

  return {
    payloads,
    meta: {
      durationMs: Date.now() - started,
      agentMeta: {
        sessionId: output.sessionId ?? claudeSessionId,
        provider: params.provider ?? "claude-cli",
        model: modelId,
        usage: output.usage,
      },
    },
  };
}
