import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isToolCallBlock,
  isToolResultBlock,
  resolveToolUseId,
  type ToolContentBlock,
} from "../chat/tool-content.js";
import type { SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { attachOpenClawTranscriptMeta } from "./session-utils.fs.js";

export const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

type ClaudeCliProjectEntry = {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    model?: unknown;
    stop_reason?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
};

type ClaudeCliMessage = NonNullable<ClaudeCliProjectEntry["message"]>;
type ClaudeCliUsage = ClaudeCliMessage["usage"];
type TranscriptLikeMessage = Record<string, unknown>;
type ToolNameRegistry = Map<string, string>;

function resolveHistoryHomeDir(homeDir?: string): string {
  return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}

function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}

export function resolveClaudeCliBindingSessionId(
  entry: SessionEntry | undefined,
): string | undefined {
  const bindingSessionId = normalizeOptionalString(
    entry?.cliSessionBindings?.[CLAUDE_CLI_PROVIDER]?.sessionId,
  );
  if (bindingSessionId) {
    return bindingSessionId;
  }
  const legacyMapSessionId = normalizeOptionalString(entry?.cliSessionIds?.[CLAUDE_CLI_PROVIDER]);
  if (legacyMapSessionId) {
    return legacyMapSessionId;
  }
  const legacyClaudeSessionId = normalizeOptionalString(entry?.claudeCliSessionId);
  return legacyClaudeSessionId || undefined;
}

function resolveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveClaudeCliUsage(raw: ClaudeCliUsage) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const input = resolveFiniteNumber(raw.input_tokens);
  const output = resolveFiniteNumber(raw.output_tokens);
  const cacheRead = resolveFiniteNumber(raw.cache_read_input_tokens);
  const cacheWrite = resolveFiniteNumber(raw.cache_creation_input_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

function normalizeClaudeCliContent(
  content: string | unknown[],
  toolNameRegistry: ToolNameRegistry,
): string | unknown[] {
  if (!Array.isArray(content)) {
    return cloneJsonValue(content);
  }

  const normalized: ToolContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      normalized.push(cloneJsonValue(item as ToolContentBlock));
      continue;
    }
    const block = cloneJsonValue(item as ToolContentBlock);
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "tool_use") {
      const id = normalizeOptionalString(block.id) ?? "";
      const name = normalizeOptionalString(block.name) ?? "";
      if (id && name) {
        toolNameRegistry.set(id, name);
      }
      if (block.input !== undefined && block.arguments === undefined) {
        block.arguments = cloneJsonValue(block.input);
      }
      block.type = "toolcall";
      delete block.input;
      normalized.push(block);
      continue;
    }
    if (type === "tool_result") {
      const toolUseId = resolveToolUseId(block);
      if (!block.name && toolUseId) {
        const toolName = toolNameRegistry.get(toolUseId);
        if (toolName) {
          block.name = toolName;
        }
      }
      normalized.push(block);
      continue;
    }
    normalized.push(block);
  }
  return normalized;
}

function getMessageBlocks(message: unknown): ToolContentBlock[] | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ToolContentBlock[]) : null;
}

function isAssistantToolCallMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") {
    return false;
  }
  const blocks = getMessageBlocks(message);
  return Boolean(blocks && blocks.length > 0 && blocks.every(isToolCallBlock));
}

function isUserToolResultMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user") {
    return false;
  }
  const blocks = getMessageBlocks(message);
  return Boolean(blocks && blocks.length > 0 && blocks.every(isToolResultBlock));
}

function coalesceClaudeCliToolMessages(messages: TranscriptLikeMessage[]): TranscriptLikeMessage[] {
  const coalesced: TranscriptLikeMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const next = messages[index + 1];
    if (!isAssistantToolCallMessage(current) || !isUserToolResultMessage(next)) {
      coalesced.push(current);
      continue;
    }

    const callBlocks = getMessageBlocks(current) ?? [];
    const resultBlocks = getMessageBlocks(next) ?? [];
    const callIds = new Set(
      callBlocks.map(resolveToolUseId).filter((id): id is string => Boolean(id)),
    );
    const allResultsMatch =
      resultBlocks.length > 0 &&
      resultBlocks.every((block) => {
        const toolUseId = resolveToolUseId(block);
        return Boolean(toolUseId && callIds.has(toolUseId));
      });
    if (!allResultsMatch) {
      coalesced.push(current);
      continue;
    }

    coalesced.push({
      ...current,
      content: [...callBlocks.map(cloneJsonValue), ...resultBlocks.map(cloneJsonValue)],
    });
    index += 1;
  }
  return coalesced;
}

function parseClaudeCliHistoryEntry(
  entry: ClaudeCliProjectEntry,
  cliSessionId: string,
  toolNameRegistry: ToolNameRegistry,
): TranscriptLikeMessage | null {
  if (entry.isSidechain === true || !entry.message || typeof entry.message !== "object") {
    return null;
  }
  const type = typeof entry.type === "string" ? entry.type : undefined;
  const role = typeof entry.message.role === "string" ? entry.message.role : undefined;
  if ((type !== "user" && type !== "assistant") || role !== type) {
    return null;
  }

  const timestamp = resolveTimestampMs(entry.timestamp);
  const baseMeta = {
    importedFrom: CLAUDE_CLI_PROVIDER,
    cliSessionId,
    ...(normalizeOptionalString(entry.uuid) ? { externalId: entry.uuid } : {}),
  };

  const content =
    typeof entry.message.content === "string" || Array.isArray(entry.message.content)
      ? normalizeClaudeCliContent(entry.message.content, toolNameRegistry)
      : undefined;
  if (content === undefined) {
    return null;
  }

  if (type === "user") {
    return attachOpenClawTranscriptMeta(
      {
        role: "user",
        content,
        ...(timestamp !== undefined ? { timestamp } : {}),
      },
      baseMeta,
    ) as TranscriptLikeMessage;
  }

  return attachOpenClawTranscriptMeta(
    {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: CLAUDE_CLI_PROVIDER,
      ...(normalizeOptionalString(entry.message.model) ? { model: entry.message.model } : {}),
      ...(normalizeOptionalString(entry.message.stop_reason)
        ? { stopReason: entry.message.stop_reason }
        : {}),
      ...(resolveClaudeCliUsage(entry.message.usage)
        ? { usage: resolveClaudeCliUsage(entry.message.usage) }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
    baseMeta,
  ) as TranscriptLikeMessage;
}

export function resolveClaudeCliSessionFilePath(params: {
  cliSessionId: string;
  homeDir?: string;
}): string | undefined {
  const projectsDir = resolveClaudeProjectsDir(params.homeDir);
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${params.cliSessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function readClaudeCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
}): TranscriptLikeMessage[] {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: TranscriptLikeMessage[] = [];
  const toolNameRegistry: ToolNameRegistry = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ClaudeCliProjectEntry;
      const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId, toolNameRegistry);
      if (message) {
        messages.push(message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
  return coalesceClaudeCliToolMessages(messages);
}
