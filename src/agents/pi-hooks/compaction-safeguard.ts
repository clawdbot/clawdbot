import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, FileOperations } from "@mariozechner/pi-coding-agent";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isAbortError } from "../../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getCompactionProvider,
  type CompactionProvider,
} from "../../plugins/compaction-provider.js";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "../compaction-real-conversation.js";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import { isTimeoutError } from "../failover-error.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import {
  composeSplitTurnInstructions,
  resolveCompactionInstructions,
} from "./compaction-instructions.js";
import {
  appendSummarySection,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  extractOpaqueIdentifiers,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancelReason,
} from "./compaction-safeguard-runtime.js";

const log = createSubsystemLogger("compaction-safeguard");

// Track session managers that have already logged the missing-model warning to avoid log spam.
const missedModelWarningSessions = new WeakSet<object>();
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
const MAX_FILE_OPS_SECTION_CHARS = 2_000;
const MAX_FILE_OPS_LIST_CHARS = 900;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const PREVIOUS_SUMMARY_REDISTILL_PREFIX =
  "Previous compaction summary to re-distill with the current conversation. " +
  "Prune stale, duplicate, or superseded details instead of preserving it verbatim.";
const compactionSafeguardDeps = {
  summarizeInStages,
};

function buildPreviousSummaryMessage(previousSummary: string): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary.trim()}\n</previous-compaction-summary>`,
      },
    ],
    timestamp: 0,
  } as AgentMessage;
}

function prependPreviousSummaryForRedistill(params: {
  messages: AgentMessage[];
  previousSummary?: string;
}): AgentMessage[] {
  const previousSummary = params.previousSummary?.trim();
  if (!previousSummary) {
    return params.messages;
  }
  return [buildPreviousSummaryMessage(previousSummary), ...params.messages];
}

/**
 * Attempt provider-based summarization. Returns the summary string on success,
 * or `undefined` when the caller should fall back to built-in LLM summarization.
 * Rethrows abort/timeout errors so cancellation is always respected.
 */
async function tryProviderSummarize(
  provider: CompactionProvider,
  params: {
    messages: unknown[];
    signal?: AbortSignal;
    customInstructions?: string;
    summarizationInstructions?: {
      identifierPolicy?: "strict" | "off" | "custom";
      identifierInstructions?: string;
    };
    previousSummary?: string;
  },
): Promise<string | undefined> {
  try {
    const result = await provider.summarize(params);
    if (typeof result === "string" && result.trim()) {
      return result;
    }
    log.warn(`Compaction provider "${provider.id}" returned empty result, falling back to LLM.`);
    return undefined;
  } catch (err) {
    // Abort/timeout errors must propagate — the caller requested cancellation.
    if (isAbortError(err) || isTimeoutError(err)) {
      throw err;
    }
    log.warn(
      `Compaction provider "${provider.id}" failed, falling back to LLM: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Summarize via the built-in LLM pipeline (summarizeInStages).
 * Only called when no compaction provider is available or the provider failed.
 */
async function summarizeViaLLM(params: {
  messages: AgentMessage[];
  model: NonNullable<Parameters<typeof summarizeInStages>[0]["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: Parameters<typeof summarizeInStages>[0]["summarizationInstructions"];
  previousSummary?: string;
}): Promise<string> {
  const messages = prependPreviousSummaryForRedistill({
    messages: params.messages,
    previousSummary: params.previousSummary,
  });
  return compactionSafeguardDeps.summarizeInStages({
    messages,
    model: params.model,
    apiKey: params.apiKey,
    headers: params.headers,
    signal: params.signal,
    reserveTokens: params.reserveTokens,
    maxChunkTokens: params.maxChunkTokens,
    contextWindow: params.contextWindow,
    customInstructions: params.customInstructions,
    summarizationInstructions: params.summarizationInstructions,
    previousSummary: undefined,
  });
}

/**
 * Build the reserved suffix that follows the summary body. Both the provider
 * and LLM paths use this so diagnostic sections survive truncation.
 */
function assembleSuffix(parts: {
  splitTurnSection?: string;
  preservedTurnsSection?: string;
  toolFailureSection?: string;
  fileOpsSummary?: string;
  workspaceContext?: string;
}): string {
  let suffix = "";
  suffix = appendSummarySection(suffix, parts.splitTurnSection ?? "");
  suffix = appendSummarySection(suffix, parts.preservedTurnsSection ?? "");
  suffix = appendSummarySection(suffix, parts.toolFailureSection ?? "");
  suffix = appendSummarySection(suffix, parts.fileOpsSummary ?? "");
  suffix = appendSummarySection(suffix, parts.workspaceContext ?? "");
  // Ensure leading separator so suffix does not merge with body (e.g. when body
  // ends without newline: "...## Exact identifiers## Tool Failures").
  if (suffix && !/^\s/.test(suffix)) {
    suffix = `\n\n${suffix}`;
  }
  return suffix;
}

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

type ModelRegistryWithRequestAuthLookup = {
  getApiKeyAndHeaders?: (
    model: NonNullable<ExtensionContext["model"]>,
  ) => Promise<ResolvedRequestAuth>;
};

type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Resolve model credentials. Returns auth details on success or a cancel reason on failure.
 * Extracted to keep the main handler readable when model/auth is conditional.
 */
async function resolveModelAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<
  { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; reason: string }
> {
  let requestAuth: ResolvedRequestAuth;
  try {
    const modelRegistry = ctx.modelRegistry as ModelRegistryWithRequestAuthLookup;
    if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
      throw new Error("model registry auth lookup unavailable");
    }
    requestAuth = await modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(
      `Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`,
    };
  }
  if (!requestAuth.ok) {
    log.warn(
      `Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`,
    };
  }
  if (!requestAuth.apiKey && !requestAuth.headers) {
    log.warn(
      "Compaction safeguard: no request credentials available; cancelling compaction to preserve history.",
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}.`,
    };
  }
  return { ok: true, apiKey: requestAuth.apiKey, headers: requestAuth.headers };
}

function buildCompactionSummaryHeaders(params: {
  model: NonNullable<ExtensionContext["model"]>;
  messages: AgentMessage[];
  headers?: Record<string, string>;
}): Record<string, string> | undefined {
  if (params.model.provider !== "github-copilot") {
    return params.headers;
  }
  const messages = params.messages as unknown as Parameters<
    typeof buildCopilotDynamicHeaders
  >[0]["messages"];
  return {
    ...buildCopilotDynamicHeaders({
      messages,
      hasImages: hasCopilotVisionInput(messages),
    }),
    ...params.headers,
  };
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(normalized));
}

function resolveRecentTurnsPreserve(value: unknown): number {
  return Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE),
  );
}

function resolveQualityGuardMaxRetries(value: unknown): number {
  return Math.min(
    MAX_QUALITY_GUARD_MAX_RETRIES,
    clampNonNegativeInt(value, DEFAULT_QUALITY_GUARD_MAX_RETRIES),
  );
}

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (exitCode !== undefined) {
    parts.push(`exitCode=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractToolResultText(content: unknown): string {
  return collectTextContentBlocks(content).join("\n");
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) {
      continue;
    }
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) {
      continue;
    }
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({ toolCallId, toolName, summary, meta });
  }

  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  function formatBoundedFileList(tag: string, files: string[], maxChars: number): string {
    if (files.length === 0 || maxChars <= 0) {
      return "";
    }
    const openTag = `<${tag}>\n`;
    const closeTag = `\n</${tag}>`;
    const lines: string[] = [];
    let usedChars = openTag.length + closeTag.length;

    for (let i = 0; i < files.length; i++) {
      const line = `${files[i]}\n`;
      const remaining = files.length - i - 1;
      const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
      const projected = usedChars + line.length + overflowLine.length;
      if (projected > maxChars) {
        const overflow = `...and ${files.length - i} more\n`;
        if (usedChars + overflow.length <= maxChars) {
          lines.push(overflow);
        }
        break;
      }
      lines.push(line);
      usedChars += line.length;
    }

    return lines.length > 0 ? `${openTag}${lines.join("")}${closeTag}` : "";
  }

  const sections: string[] = [];
  const readSection = formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS);
  const modifiedSection = formatBoundedFileList(
    "modified-files",
    modifiedFiles,
    MAX_FILE_OPS_LIST_CHARS,
  );
  if (readSection) {
    sections.push(readSection);
  }
  if (modifiedSection) {
    sections.push(modifiedSection);
  }
  if (sections.length === 0) {
    return "";
  }
  const combined = `\n\n${sections.join("\n\n")}`;
  return capCompactionSummary(combined, MAX_FILE_OPS_SECTION_CHARS);
}

function capCompactionSummary(summary: string, maxChars = MAX_COMPACTION_SUMMARY_CHARS): string {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const marker = SUMMARY_TRUNCATED_MARKER;
  const budget = Math.max(0, maxChars - marker.length);
  if (budget <= 0) {
    // Marker cannot fit; keep body prefix instead of a partial marker fragment.
    return summary.slice(0, maxChars);
  }
  return `${summary.slice(0, budget)}${marker}`;
}

function capCompactionSummaryPreservingSuffix(
  summaryBody: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  if (!suffix) {
    return capCompactionSummary(summaryBody, maxChars);
  }
  if (maxChars <= 0) {
    return capCompactionSummary(`${summaryBody}${suffix}`, maxChars);
  }
  if (suffix.length >= maxChars) {
    // Preserve tail (workspace rules, diagnostics) over head (preserved turns).
    return suffix.slice(-maxChars);
  }
  const bodyBudget = Math.max(0, maxChars - suffix.length);
  const cappedBody = capCompactionSummary(summaryBody, bodyBudget);
  return `${cappedBody}${suffix}`;
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content === null || content === undefined) {
    return null;
  }
  if (typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  if (typeCounts.size === 0) {
    return null;
  }
  const parts = [...typeCounts.entries()].map(([type, count]) =>
    count > 1 ? `${type} x${count}` : type,
  );
  return `[non-text content: ${parts.join(", ")}]`;
}

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(params.recentTurnsPreserve, 0),
  );
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const conversationIndexes: number[] = [];
  const userIndexes: number[] = [];
  for (let i = 0; i < params.messages.length; i += 1) {
    const role = (params.messages[i] as { role?: unknown }).role;
    if (role === "user" || role === "assistant") {
      conversationIndexes.push(i);
      if (role === "user") {
        userIndexes.push(i);
      }
    }
  }
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const preservedIndexSet = new Set<number>();
  if (userIndexes.length >= preserveTurns) {
    const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
    if (boundaryStartIndex >= 0) {
      for (const index of conversationIndexes) {
        if (index >= boundaryStartIndex) {
          preservedIndexSet.add(index);
        }
      }
    }
  } else {
    const fallbackMessageCount = preserveTurns * 2;
    for (const userIndex of userIndexes) {
      preservedIndexSet.add(userIndex);
    }
    for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
      const index = conversationIndexes[i];
      if (index === undefined) {
        continue;
      }
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= fallbackMessageCount) {
        break;
      }
    }
  }
  if (preservedIndexSet.size === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const preservedToolCallIds = new Set<string>();
  for (let i = 0; i < params.messages.length; i += 1) {
    if (!preservedIndexSet.has(i)) {
      continue;
    }
    const message = params.messages[i];
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(
      message as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) {
      preservedToolCallIds.add(toolCall.id);
    }
  }
  if (preservedToolCallIds.size > 0) {
    let preservedStartIndex = -1;
    for (let i = 0; i < params.messages.length; i += 1) {
      if (preservedIndexSet.has(i)) {
        preservedStartIndex = i;
        break;
      }
    }
    if (preservedStartIndex >= 0) {
      for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
        const message = params.messages[i];
        if ((message as { role?: unknown }).role !== "toolResult") {
          continue;
        }
        const toolResultId = extractToolResultId(
          message as Extract<AgentMessage, { role: "toolResult" }>,
        );
        if (toolResultId && preservedToolCallIds.has(toolResultId)) {
          preservedIndexSet.add(i);
        }
      }
    }
  }
  const summarizableMessages = params.messages.filter((_, idx) => !preservedIndexSet.has(idx));
  // Preserving recent assistant turns can orphan downstream toolResult messages.
  // Repair pairings here so compaction summarization doesn't trip strict providers.
  const repairedSummarizableMessages = repairToolUseResultPairing(summarizableMessages).messages;
  const preservedMessages = params.messages
    .filter((_, idx) => preservedIndexSet.has(idx))
    .filter((msg) => {
      const role = (msg as { role?: unknown }).role;
      return role === "user" || role === "assistant" || role === "toolResult";
    });
  return { summarizableMessages: repairedSummarizableMessages, preservedMessages };
}

function formatContextMessages(messages: AgentMessage[]): string[] {
  return messages
    .map((message) => {
      let roleLabel: string;
      if (message.role === "assistant") {
        roleLabel = "Assistant";
      } else if (message.role === "user") {
        roleLabel = "User";
      } else if (message.role === "toolResult") {
        const toolName = (message as { toolName?: unknown }).toolName;
        const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
        roleLabel = `Tool result (${safeToolName})`;
      } else {
        return null;
      }
      const text = extractMessageText(message);
      const nonTextPlaceholder = formatNonTextPlaceholder(
        (message as { content?: unknown }).content,
      );
      const rendered =
        text && nonTextPlaceholder ? `${text}\n${nonTextPlaceholder}` : text || nonTextPlaceholder;
      if (!rendered) {
        return null;
      }
      const trimmed =
        rendered.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${rendered.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : rendered;
      return `- ${roleLabel}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
}

function formatPreservedTurnsSection(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = formatContextMessages(messages);
  if (lines.length === 0) {
    return "";
  }
  return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}

function formatSplitTurnContextSection(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = formatContextMessages(messages);
  if (lines.length === 0) {
    return "";
  }
  return `**Turn Context (split turn):**\n\n${lines.join("\n")}`;
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    const text = extractMessageText(message);
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Falls back to legacy names "Every Session" and "Safety".
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  const workspaceDir = process.cwd();
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openBoundaryFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return "";
    }

    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();
    // Accept legacy section names ("Every Session", "Safety") as fallback
    // for backward compatibility with older AGENTS.md templates.
    let sections = extractSections(content, ["Session Startup", "Red Lines"]);
    if (sections.length === 0) {
      sections = extractSections(content, ["Every Session", "Safety"]);
    }

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
}

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions: eventInstructions, signal } = event;
    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    const baseMessagesToSummarize = stripRuntimeContextCustomMessages(
      preparation.messagesToSummarize,
    );
    const baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
    const hasRealSummarizable = baseMessagesToSummarize.some((message, index, messages) =>
      isRealConversationMessage(message, messages, index),
    );
    const hasRealTurnPrefix = baseTurnPrefixMessages.some((message, index, messages) =>
      isRealConversationMessage(message, messages, index),
    );
    setCompactionSafeguardCancelReason(ctx.sessionManager, undefined);
    if (!hasRealSummarizable && !hasRealTurnPrefix) {
      // When there are no summarizable messages AND no real turn-prefix content,
      // cancelling compaction leaves context unchanged but the SDK re-triggers
      // _checkCompaction after every assistant response — creating a cancel loop
      // that blocks cron lanes (#41981).
      //
      // Strategy: always return a minimal compaction result so the SDK writes a
      // boundary entry. The SDK's prepareCompaction() returns undefined when the
      // last entry is a compaction, which blocks immediate re-triggering within
      // the same turn. After a new assistant message arrives, if the SDK triggers
      // compaction again with an empty preparation, we write another boundary —
      // this is bounded to at most one boundary per LLM round-trip, not a tight
      // loop.
      log.info(
        "Compaction safeguard: no real conversation messages to summarize; writing compaction boundary to suppress re-trigger loop.",
      );
      const fallbackSummary = buildStructuredFallbackSummary(preparation.previousSummary);
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...baseMessagesToSummarize,
      ...baseTurnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);

    // Model resolution: ctx.model is undefined in compact.ts workflow (extensionRunner.initialize() is never called).
    // Fall back to runtime.model which is explicitly passed when building extension paths.
    const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const customInstructions = resolveCompactionInstructions(
      eventInstructions,
      runtime?.customInstructions,
    );
    const summarizationInstructions = {
      identifierPolicy: runtime?.identifierPolicy,
      identifierInstructions: runtime?.identifierInstructions,
    };
    const identifierPolicy = runtime?.identifierPolicy ?? "strict";
    const providerId = runtime?.provider;
    const turnPrefixMessages = baseTurnPrefixMessages;
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
    const { preservedMessages: providerPreservedMessages } = splitPreservedRecentTurns({
      messages: baseMessagesToSummarize,
      recentTurnsPreserve,
    });
    const preservedTurnsSection = formatPreservedTurnsSection(providerPreservedMessages);
    const splitTurnSection = preparation.isSplitTurn
      ? formatSplitTurnContextSection(turnPrefixMessages)
      : "";
    const structuredInstructions = buildCompactionStructureInstructions(
      customInstructions,
      summarizationInstructions,
    );

    // -----------------------------------------------------------------------
    // Provider path — one call with all messages, no LLM-specific prep.
    // Falls through to the LLM path below on failure.
    // -----------------------------------------------------------------------
    if (providerId) {
      const compactionProvider = getCompactionProvider(providerId);
      if (compactionProvider) {
        try {
          // Give the provider ALL messages — no pruning, no chunking, no split-turn splitting.
          // The provider handles its own context management.
          const allMessages = [...baseMessagesToSummarize, ...turnPrefixMessages];
          const providerResult = await tryProviderSummarize(compactionProvider, {
            messages: allMessages,
            signal,
            customInstructions: structuredInstructions,
            summarizationInstructions,
            previousSummary: preparation.previousSummary,
          });

          if (providerResult !== undefined) {
            // Provider succeeded — assemble suffix metadata and return.
            // No quality guard: the provider is trusted.
            const workspaceContext = await readWorkspaceContextForSummary();
            const suffix = assembleSuffix({
              splitTurnSection,
              preservedTurnsSection,
              toolFailureSection,
              fileOpsSummary,
              workspaceContext,
            });
            const summary = capCompactionSummaryPreservingSuffix(providerResult, suffix);
            return {
              compaction: {
                summary,
                firstKeptEntryId: preparation.firstKeptEntryId,
                tokensBefore: preparation.tokensBefore,
                details: { readFiles, modifiedFiles },
              },
            };
          }
          // Provider returned empty — fall through to LLM path.
          log.info("Compaction provider did not produce a result; falling back to LLM path.");
        } catch (err) {
          // tryProviderSummarize rethrows abort/timeout — if we reach here it is
          // an unexpected error from the assembly step. Fall through to LLM path.
          if (isAbortError(err) || isTimeoutError(err)) {
            throw err;
          }
          log.warn(
            `Compaction provider path failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        log.warn(
          `Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // LLM path — resolve model + auth, prune, chunk, quality guard.
    // -----------------------------------------------------------------------
    const model = ctx.model ?? runtime?.model;
    if (!model) {
      if (!ctx.model && !runtime?.model && !missedModelWarningSessions.has(ctx.sessionManager)) {
        missedModelWarningSessions.add(ctx.sessionManager);
        log.warn(
          "[compaction-safeguard] Both ctx.model and runtime.model are undefined. " +
            "Compaction summarization will not run. This indicates extensionRunner.initialize() " +
            "was not called and model was not passed through runtime registry.",
        );
      }
      setCompactionSafeguardCancelReason(
        ctx.sessionManager,
        "Compaction safeguard could not resolve a summarization model.",
      );
      return { cancel: true };
    }

    const authResult = await resolveModelAuth(ctx, model);
    if (!authResult.ok) {
      setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);
      return { cancel: true };
    }
    const apiKey = authResult.apiKey ?? "";
    const authHeaders = authResult.headers;

    try {
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      let messagesToSummarize = baseMessagesToSummarize;
      const headers = buildCompactionSummaryHeaders({
        model,
        messages: messagesToSummarize,
        headers: authHeaders,
      });
      const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            log.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            // Summarize dropped messages so context isn't lost
            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeViaLLM({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  headers,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: structuredInstructions,
                  summarizationInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                log.warn(
                  `Compaction safeguard: failed to summarize dropped messages, continuing without: ${formatErrorMessage(
                    droppedError,
                  )}`,
                );
              }
            }
          }
        }
      }

      const {
        summarizableMessages: summaryTargetMessages,
        preservedMessages: preservedRecentMessages,
      } = splitPreservedRecentTurns({
        messages: messagesToSummarize,
        recentTurnsPreserve,
      });
      messagesToSummarize = summaryTargetMessages;
      const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
      const latestUserAsk = extractLatestUserAsk([...messagesToSummarize, ...turnPrefixMessages]);
      const identifierSeedText = [...messagesToSummarize, ...turnPrefixMessages]
        .slice(-10)
        .map((message) => extractMessageText(message))
        .filter(Boolean)
        .join("\n");
      const identifiers = extractOpaqueIdentifiers(identifierSeedText);

      // Use adaptive chunk ratio based on message sizes, reserving headroom for
      // the summarization prompt, system prompt, previous summary, and reasoning budget
      // that generateSummary adds on top of the serialized conversation chunk.
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(
        1,
        Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
      );
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      let summary = "";
      let lastHistorySummary = "";
      let lastSplitTurnSection = "";
      let currentInstructions = structuredInstructions;
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      let lastSuccessfulSummary: string | null = null;

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let summaryWithoutPreservedTurns = "";
        let summaryWithPreservedTurns = "";
        let splitTurnSection = "";
        let historySummary = "";
        try {
          historySummary =
            messagesToSummarize.length > 0
              ? await summarizeViaLLM({
                  messages: messagesToSummarize,
                  model,
                  apiKey,
                  headers,
                  signal,
                  reserveTokens,
                  maxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: currentInstructions,
                  summarizationInstructions,
                  previousSummary: effectivePreviousSummary,
                })
              : buildStructuredFallbackSummary(effectivePreviousSummary, summarizationInstructions);

          summaryWithoutPreservedTurns = historySummary;
          if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
            const prefixSummary = await summarizeViaLLM({
              messages: turnPrefixMessages,
              model,
              apiKey,
              headers,
              signal,
              reserveTokens,
              maxChunkTokens,
              contextWindow: contextWindowTokens,
              customInstructions: composeSplitTurnInstructions(
                TURN_PREFIX_INSTRUCTIONS,
                currentInstructions,
              ),
              summarizationInstructions,
              previousSummary: undefined,
            });
            splitTurnSection = `**Turn Context (split turn):**\n\n${prefixSummary}`;
            summaryWithoutPreservedTurns = historySummary.trim()
              ? `${historySummary}\n\n---\n\n${splitTurnSection}`
              : splitTurnSection;
          }
          summaryWithPreservedTurns = appendSummarySection(
            summaryWithoutPreservedTurns,
            preservedTurnsSection,
          );
        } catch (attemptError) {
          if (lastSuccessfulSummary && attempt > 0) {
            log.warn(
              `Compaction safeguard: quality retry failed on attempt ${attempt + 1}; ` +
                `keeping last successful summary: ${formatErrorMessage(attemptError)}`,
            );
            summary = lastSuccessfulSummary;
            break;
          }
          throw attemptError;
        }
        lastSuccessfulSummary = summaryWithPreservedTurns;
        lastHistorySummary = historySummary;
        lastSplitTurnSection = splitTurnSection;

        const canRegenerate =
          messagesToSummarize.length > 0 ||
          (preparation.isSplitTurn && turnPrefixMessages.length > 0);
        if (!qualityGuardEnabled || !canRegenerate) {
          summary = summaryWithPreservedTurns;
          break;
        }
        const quality = auditSummaryQuality({
          summary: summaryWithoutPreservedTurns,
          identifiers,
          latestAsk: latestUserAsk,
          identifierPolicy,
        });
        summary = summaryWithPreservedTurns;
        if (quality.ok || attempt >= totalAttempts - 1) {
          break;
        }
        const reasons = quality.reasons.join(", ");
        const qualityFeedbackInstruction =
          identifierPolicy === "strict"
            ? "Fix all issues and include every required section with exact identifiers preserved."
            : "Fix all issues and include every required section while following the configured identifier policy.";
        const qualityFeedbackReasons = wrapUntrustedInstructionBlock(
          "Quality check feedback",
          `Previous summary failed quality checks (${reasons}).`,
        );
        currentInstructions = qualityFeedbackReasons
          ? `${structuredInstructions}\n\n${qualityFeedbackInstruction}\n\n${qualityFeedbackReasons}`
          : `${structuredInstructions}\n\n${qualityFeedbackInstruction}`;
      }

      // Cap the main history body first, then append split-turn context, preserved
      // turns, diagnostics, and workspace rules so they survive truncation.
      const workspaceContext = await readWorkspaceContextForSummary();
      const suffix = assembleSuffix({
        splitTurnSection: lastSplitTurnSection,
        preservedTurnsSection,
        toolFailureSection,
        fileOpsSummary,
        workspaceContext,
      });
      const bodyToCap = lastHistorySummary || summary;
      summary = capCompactionSummaryPreservingSuffix(bodyToCap, suffix);

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      const message = formatErrorMessage(error);
      log.warn(
        `Compaction summarization failed; cancelling compaction to preserve history: ${message}`,
      );
      setCompactionSafeguardCancelReason(
        ctx.sessionManager,
        `Compaction safeguard could not summarize the session: ${message}`,
      );
      return { cancel: true };
    }
  });
}

export const __testing = {
  setSummarizeInStagesForTest(next?: typeof summarizeInStages) {
    compactionSafeguardDeps.summarizeInStages = next ?? summarizeInStages;
  },
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  formatPreservedTurnsSection,
  formatSplitTurnContextSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  capCompactionSummaryPreservingSuffix,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  readWorkspaceContextForSummary,
  hasMeaningfulConversationContent,
  isRealConversationMessage,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  MAX_FILE_OPS_LIST_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} as const;
