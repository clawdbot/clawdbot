// Claude CLI session history importer.
// Converts Claude project JSONL into OpenClaw transcript-compatible messages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hashCliReseedPrompt, parseCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import {
  isToolCallBlock,
  isToolResultBlock,
  resolveToolUseId,
  type ToolContentBlock,
} from "../chat/tool-content.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import {
  getCliSessionBinding,
  normalizeCliSessionReseedReceipt,
} from "../config/sessions/cli-session-binding.js";
import { attachOpenClawTranscriptMeta } from "./session-transcript-readers.js";

export const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

type ClaudeCliProjectEntry = {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
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
type ReseedImportState = {
  receipt?: CliSessionReseedReceipt;
  inspectedFirstUser: boolean;
};

function resolveHistoryHomeDir(homeDir?: string): string {
  return normalizeOptionalString(homeDir) || process.env.HOME || os.homedir();
}

function resolveClaudeProjectsDir(homeDir?: string): string {
  return path.join(resolveHistoryHomeDir(homeDir), CLAUDE_PROJECTS_RELATIVE_DIR);
}

export function resolveClaudeCliBindingSessionId(
  entry: SessionEntry | undefined,
): string | undefined {
  return getCliSessionBinding(entry, CLAUDE_CLI_PROVIDER)?.sessionId;
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
  const input = asFiniteNumber(raw.input_tokens);
  const output = asFiniteNumber(raw.output_tokens);
  const cacheRead = asFiniteNumber(raw.cache_read_input_tokens);
  const cacheWrite = asFiniteNumber(raw.cache_creation_input_tokens);
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

function removeContentBlock<T>(content: T[], blockIndex: number): T[] | null {
  const nextContent = cloneJsonValue(content);
  nextContent.splice(blockIndex, 1);
  return nextContent.length > 0 ? nextContent : null;
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
      // Claude stores tool calls as `tool_use` with `input`; OpenClaw history
      // expects `toolcall` plus `arguments` so replay remains provider-neutral.
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
    const current = messages.at(index);
    if (current === undefined) {
      break;
    }
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

type ClaudeCliPromptTextCandidate = {
  text: string;
  blockIndex?: number;
};

function resolveClaudeCliPromptTextCandidates(
  entry: ClaudeCliProjectEntry,
  content: string | unknown[],
): ClaudeCliPromptTextCandidate[] {
  if (entry.isMeta === true || entry.isCompactSummary === true) {
    return [];
  }
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (
    content.some(
      (item) =>
        item !== null && typeof item === "object" && "type" in item && item.type === "tool_result",
    )
  ) {
    return [];
  }
  return content.flatMap((item, blockIndex) =>
    item !== null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [{ text: item.text, blockIndex }]
      : [],
  );
}

function parseClaudeCliHistoryEntry(
  entry: ClaudeCliProjectEntry,
  cliSessionId: string,
  toolNameRegistry: ToolNameRegistry,
  options: {
    reseedMode: "recover" | "preserve";
    reseedState?: ReseedImportState;
  },
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

  let content =
    typeof entry.message.content === "string" || Array.isArray(entry.message.content)
      ? normalizeClaudeCliContent(entry.message.content, toolNameRegistry)
      : undefined;
  if (content === undefined) {
    return null;
  }

  if (type === "user") {
    const reseedState = options.reseedState;
    const promptTextCandidates = resolveClaudeCliPromptTextCandidates(entry, content);
    if (
      options.reseedMode === "recover" &&
      reseedState &&
      !reseedState.inspectedFirstUser &&
      promptTextCandidates.length > 0
    ) {
      reseedState.inspectedFirstUser = true;
      if (reseedState.receipt) {
        // The binding is trusted state for this native session. Do not scan
        // later rows or a repeated user message could be suppressed.
        const candidate = promptTextCandidates.length === 1 ? promptTextCandidates[0] : undefined;
        if (candidate && hashCliReseedPrompt(candidate.text) === reseedState.receipt.promptHash) {
          if (candidate.blockIndex === undefined || !Array.isArray(content)) {
            return null;
          }
          // The receipt proves only the matching text block is synthetic.
          // Preserve sibling images or other native content that has no local duplicate proof.
          const nextContent = removeContentBlock(content, candidate.blockIndex);
          if (!nextContent) {
            return null;
          }
          content = nextContent;
        }
      } else {
        for (const candidate of promptTextCandidates) {
          const reseedPrompt = parseCliReseedPrompt(candidate.text);
          if (reseedPrompt.kind === "legacy") {
            if (candidate.blockIndex === undefined) {
              if (!reseedPrompt.userMessage) {
                return null;
              }
              content = reseedPrompt.userMessage;
            } else if (Array.isArray(content)) {
              if (!reseedPrompt.userMessage) {
                const contentWithoutReseed = removeContentBlock(content, candidate.blockIndex);
                if (!contentWithoutReseed) {
                  return null;
                }
                content = contentWithoutReseed;
                break;
              }
              const nextContent = cloneJsonValue(content);
              const block = nextContent[candidate.blockIndex];
              if (block && typeof block === "object") {
                (block as Record<string, unknown>).text = reseedPrompt.userMessage;
              }
              content = nextContent;
            }
            break;
          }
        }
      }
    }
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
  const sessionId = params.cliSessionId.trim();
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    path.isAbsolute(sessionId) ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    return undefined;
  }
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
    const projectDir = path.join(projectsDir, entry.name);
    const candidate = path.resolve(projectDir, `${sessionId}.jsonl`);
    const resolvedProjectDir = path.resolve(projectDir);
    if (!candidate.startsWith(`${resolvedProjectDir}${path.sep}`)) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Reads visible messages for a bound Claude CLI session. */
export function readClaudeCliSessionMessages(params: {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
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
  const localSessionId = normalizeOptionalString(params.localSessionId);
  const normalizedReceipt = normalizeCliSessionReseedReceipt(params.reseedReceipt);
  const reseedState: ReseedImportState = {
    receipt:
      normalizedReceipt && normalizedReceipt.localSessionId === localSessionId
        ? normalizedReceipt
        : undefined,
    inspectedFirstUser: false,
  };
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ClaudeCliProjectEntry;
      const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId, toolNameRegistry, {
        reseedMode: "recover",
        reseedState,
      });
      if (message) {
        messages.push(message);
      }
    } catch {
      // Ignore malformed external history entries.
    }
  }
  return coalesceClaudeCliToolMessages(messages);
}

type ClaudeCliCompactBoundaryEntry = {
  type: "system";
  subtype?: unknown;
  content?: unknown;
  timestamp?: unknown;
  compactMetadata?: {
    trigger?: unknown;
    preTokens?: unknown;
  };
};

type ClaudeCliSummaryEntry = {
  type: "summary";
  summary?: unknown;
  leafUuid?: unknown;
  timestamp?: unknown;
};

export type ClaudeCliFallbackSeed = {
  summaryText?: string;
  recentTurns: TranscriptLikeMessage[];
};

function isCompactBoundary(entry: ClaudeCliProjectEntry): boolean {
  if (entry.type !== "system") {
    return false;
  }
  const subtype = (entry as ClaudeCliCompactBoundaryEntry).subtype;
  return typeof subtype === "string" && subtype === "compact_boundary";
}

function extractCompactBoundaryFallbackText(entry: ClaudeCliProjectEntry): string | undefined {
  const content = (entry as ClaudeCliCompactBoundaryEntry).content;
  return typeof content === "string" && content.trim() ? content.trim() : undefined;
}

function extractSummaryText(entry: ClaudeCliProjectEntry): string | undefined {
  if (entry.type !== "summary") {
    return undefined;
  }
  const summary = (entry as ClaudeCliSummaryEntry).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

export function readClaudeCliFallbackSeed(params: {
  cliSessionId: string;
  homeDir?: string;
}): ClaudeCliFallbackSeed | undefined {
  const filePath = resolveClaudeCliSessionFilePath(params);
  if (!filePath) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  let pendingSummary: string | undefined;
  let lastSummary: string | undefined;
  let lastBoundaryFallback: string | undefined;
  let windowedTurns: TranscriptLikeMessage[] = [];
  const toolNameRegistry: ToolNameRegistry = new Map();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: ClaudeCliProjectEntry;
    try {
      parsed = JSON.parse(line) as ClaudeCliProjectEntry;
    } catch {
      continue;
    }

    const explicitSummary = extractSummaryText(parsed);
    if (explicitSummary) {
      pendingSummary = explicitSummary;
      continue;
    }

    if (isCompactBoundary(parsed)) {
      // Compact boundaries split Claude history into context windows. Keep the
      // latest summary plus only post-boundary turns for fallback seeding.
      lastSummary = pendingSummary;
      pendingSummary = undefined;
      lastBoundaryFallback = extractCompactBoundaryFallbackText(parsed) ?? lastBoundaryFallback;
      windowedTurns = [];
      toolNameRegistry.clear();
      continue;
    }

    const message = parseClaudeCliHistoryEntry(parsed, params.cliSessionId, toolNameRegistry, {
      reseedMode: "preserve",
    });
    if (message) {
      windowedTurns.push(message);
    }
  }

  const recentTurns = coalesceClaudeCliToolMessages(windowedTurns);
  const resolvedSummaryText = lastSummary ?? pendingSummary ?? lastBoundaryFallback;
  if (!resolvedSummaryText && recentTurns.length === 0) {
    return undefined;
  }
  return {
    ...(resolvedSummaryText ? { summaryText: resolvedSummaryText } : {}),
    recentTurns,
  };
}
