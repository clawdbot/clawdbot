/** Extension that safeguards compaction with structured summaries and quality repair. */

import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getCompactionProvider,
  type CompactionProvider,
} from "../../plugins/compaction-provider.js";
import { normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
import { computeAdaptiveChunkRatioWithWorker } from "../compaction-planning-worker.js";
import { buildHistoryPrunePlan } from "../compaction-planning.js";
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
  isOversizedForSummary,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import { isTimeoutError } from "../failover-error.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import type { ExtensionAPI, ExtensionContext, FileOperations } from "../sessions/index.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "../workspace-bootstrap-read.js";
import { resolveCompactionInstructions } from "./compaction-instructions.js";
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
const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
const PREVIOUS_SUMMARY_REDISTILL_PREFIX =
  "Previous compaction summary to re-distill with the current conversation. " +
  "Prune stale, duplicate, or superseded details instead of preserving it verbatim.";
const compactionSafeguardDeps = {
  summarizeInStages,
};

function prependPreviousSummaryForRedistill(params: {
  messages: AgentMessage[];
  previousSummary?: string;
}): AgentMessage[] {
  const previousSummary = params.previousSummary?.trim();
  if (!previousSummary) {
    return params.messages;
  }
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary}\n</previous-compaction-summary>`,
        },
      ],
      timestamp: 0,
    } as AgentMessage,
    ...params.messages,
  ];
}

function coerceTimestamp(value: unknown): number {
  const timestamp = typeof value === "string" ? Date.parse(value) : value;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
}

function sessionBranchEntryToMessage(entry: Record<string, unknown>): unknown {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: typeof entry.customType === "string" ? entry.customType : "custom",
      content: entry.content,
      display: entry.display !== false,
      details: entry.details,
      timestamp: coerceTimestamp(entry.timestamp),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      fromId: typeof entry.fromId === "string" ? entry.fromId : "root",
      timestamp: coerceTimestamp(entry.timestamp),
    };
  }
  return undefined;
}

function collectSessionBranchMessages(sessionManager: unknown): AgentMessage[] {
  try {
    const entries: unknown = (sessionManager as { getBranch?: () => unknown })?.getBranch?.();
    return Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const message =
            entry && typeof entry === "object"
              ? sessionBranchEntryToMessage(entry as Record<string, unknown>)
              : undefined;
          return message ? [message as AgentMessage] : [];
        })
      : [];
  } catch {
    return [];
  }
}

function isSessionsSendToolName(value: unknown): boolean {
  return (
    normalizeOptionalString(value)
      ?.toLowerCase()
      .replace(/^(?:functions?|tools?)[./_-]/, "") === "sessions_send"
  );
}

function sanitizeSourceSessionSends(messages: AgentMessage[]): AgentMessage[] {
  const sendCallIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? extractToolCallsFromAssistant(message)
            .filter((call) => isSessionsSendToolName(call.name))
            .map((call) => call.id.trim())
            .filter(Boolean)
        : [],
    ),
  );
  const resultTextByCallId = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "toolResult") {
      continue;
    }
    const callId = extractToolResultId(message);
    if (!callId || !sendCallIds.has(callId)) {
      continue;
    }
    resultTextByCallId.set(
      callId,
      extractMessageText(message) || formatNonTextPlaceholder(message.content) || "",
    );
  }

  return messages.flatMap((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      let replaced = false;
      const content = message.content.map((block) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const record = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (
          typeof record.type !== "string" ||
          !TOOL_CALL_BLOCK_TYPES.has(record.type) ||
          !isSessionsSendToolName(record.name)
        ) {
          return block;
        }
        replaced = true;
        const callId = typeof record.id === "string" ? record.id.trim() : "";
        const resultText = callId ? resultTextByCallId.get(callId) : undefined;
        const resolved = Boolean(callId && resultTextByCallId.has(callId));
        const requestText = JSON.stringify({ callId: callId || undefined, args: record.arguments });
        const resultSuffix = resolved ? `\nResult: ${resultText || "[empty]"}` : "";
        return {
          type: "text",
          text: `sessions_send result ${resolved ? "received" : "missing"}; delivery call omitted from replay.\nRequest: ${requestText}${resultSuffix}`,
        };
      });
      return replaced ? [{ ...message, content } as AgentMessage] : [message];
    }
    if (message.role === "toolResult") {
      const callId = extractToolResultId(message);
      if ((callId && sendCallIds.has(callId)) || isSessionsSendToolName(message.toolName)) {
        return [];
      }
    }
    return [message];
  });
}

function filterReplayUnsafeSessionBranchMessages(messages: AgentMessage[]): AgentMessage[] {
  const sanitizedMessages = sanitizeSourceSessionSends(messages);
  let turnStart = sanitizedMessages.length;
  while (turnStart > 0) {
    const role = (sanitizedMessages[turnStart - 1] as { role?: unknown }).role;
    if (role !== "assistant" && role !== "toolResult") {
      break;
    }
    turnStart -= 1;
  }

  const tailMessage = messages.at(-1);
  const endsWithTerminalAssistantText =
    tailMessage !== undefined &&
    tailMessage.role === "assistant" &&
    Boolean(extractMessageText(tailMessage).trim()) &&
    (!Array.isArray(tailMessage.content) ||
      !tailMessage.content.some((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const type = (block as { type?: unknown }).type;
        return typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type);
      }));
  const activeInput = sanitizedMessages[turnStart - 1];
  const activeInputProvenance =
    activeInput?.role === "user"
      ? normalizeInputProvenance((activeInput as { provenance?: unknown }).provenance)
      : undefined;

  // A completed sessions_send target run is already delivered to its caller.
  // Require terminal text so compaction after tool output can still recover unfinished work.
  if (
    endsWithTerminalAssistantText &&
    turnStart < sanitizedMessages.length &&
    turnStart > 0 &&
    activeInputProvenance?.kind === "inter_session" &&
    activeInputProvenance.sourceTool === "sessions_send"
  ) {
    return sanitizedMessages.slice(0, turnStart - 1);
  }
  return sanitizedMessages;
}

function containsRealConversation(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}

/**
 * Summarize via the built-in LLM pipeline (summarizeInStages).
 * Only called when no compaction provider is available or the provider failed.
 */
async function summarizeViaLLM(params: Parameters<typeof summarizeInStages>[0]): Promise<string> {
  const result = await compactionSafeguardDeps.summarizeInStages({
    ...params,
    messages: prependPreviousSummaryForRedistill(params),
    previousSummary: undefined,
  });
  if (result.kind === "summary") {
    return result.text;
  }

  // A generic fallback means redistillation never happened. Preserve the
  // known summary verbatim so a temporary model outage cannot erase it.
  const previousSummary = params.previousSummary?.trim();
  return previousSummary ? `${previousSummary}\n\n${result.text}` : result.text;
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
  const suffix = Object.values(parts).reduce(
    (summary, section) => appendSummarySection(summary, section ?? ""),
    "",
  );
  // Ensure leading separator so suffix does not merge with body (e.g. when body
  // ends without newline: "...## Exact identifiers## Tool Failures").
  return suffix && !/^\s/.test(suffix) ? `\n\n${suffix}` : suffix;
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
  // `ok: true` is the registry's authoritative success signal; it already returns
  // `ok: false` when auth cannot resolve. Do not re-derive failure from absent
  // key/headers. SDK-managed modes (aws-sdk, oauth) sign the request later and
  // legitimately carry neither, so gating on them wedges compaction forever.
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

function clampNonNegativeInt(
  value: unknown,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(0, Math.floor(normalized)));
}

function resolveRecentTurnsPreserve(value: unknown): number {
  return clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE, MAX_RECENT_TURNS_PRESERVE);
}

function resolveQualityGuardMaxRetries(value: unknown): number {
  return clampNonNegativeInt(
    value,
    DEFAULT_QUALITY_GUARD_MAX_RETRIES,
    MAX_QUALITY_GUARD_MAX_RETRIES,
  );
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  return (
    [
      typeof record.status === "string" && record.status ? `status=${record.status}` : "",
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? `exitCode=${record.exitCode}`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "toolResult" || !message.isError) {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    // Accepted sessions_spawn launches are successes, not failures, even when a legacy
    // transcript persisted them with isError:true. Mirror the observer's detection
    // (toolName + accepted child-run identity, see embedded-agent-subscribe.handlers.tools)
    // so only real failures stay in the summary and non-spawn tools are never matched by shape.
    if (
      typeof toolResult.toolName === "string" &&
      toolResult.toolName.trim() === "sessions_spawn" &&
      normalizeAcceptedSessionSpawnResult(toolResult)
    ) {
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
    const meta = formatToolFailureMeta(toolResult.details);
    const failureText =
      collectTextContentBlocks(toolResult.content).join("\n").replace(/\s+/g, " ").trim() ||
      (meta ? "failed" : "failed (no output)");
    const summary =
      failureText.length > MAX_TOOL_FAILURE_CHARS
        ? `${truncateUtf16Safe(failureText, MAX_TOOL_FAILURE_CHARS - 3)}...`
        : failureText;
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

  const sections = [
    formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS),
    formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS),
  ].filter(Boolean);
  return sections.length > 0
    ? capCompactionSummary(`\n\n${sections.join("\n\n")}`, MAX_FILE_OPS_SECTION_CHARS)
    : "";
}

function capCompactionSummary(summary: string, maxChars = MAX_COMPACTION_SUMMARY_CHARS): string {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const marker = SUMMARY_TRUNCATED_MARKER;
  const budget = Math.max(0, maxChars - marker.length);
  if (budget <= 0) {
    // Marker cannot fit; keep body prefix instead of a partial marker fragment.
    return truncateUtf16Safe(summary, maxChars);
  }
  return `${truncateUtf16Safe(summary, budget)}${marker}`;
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
    return sliceUtf16Safe(suffix, -maxChars);
  }
  const bodyBudget = Math.max(0, maxChars - suffix.length);
  const cappedBody = capCompactionSummary(summaryBody, bodyBudget);
  return `${cappedBody}${suffix}`;
}

function resolveSummaryReserveTokens(
  requestedReserveTokens: number,
  model: NonNullable<Parameters<typeof summarizeInStages>[0]["model"]>,
): number {
  const requested = Math.max(1, Math.floor(requestedReserveTokens));
  const modelMaxTokens = model.maxTokens;
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requested;
  }
  return Math.max(1, Math.min(requested, Math.floor(modelMaxTokens)));
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text =
            block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
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
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = clampNonNegativeInt(
    params.recentTurnsPreserve,
    0,
    MAX_RECENT_TURNS_PRESERVE,
  );
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const conversationIndexes = params.messages.flatMap((message, index) =>
    message.role === "user" || message.role === "assistant" ? [index] : [],
  );
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const userIndexes = conversationIndexes.filter(
    (index) => params.messages[index]?.role === "user",
  );
  const boundaryStartIndex = userIndexes.at(-preserveTurns);
  const preservedIndexSet = new Set(
    boundaryStartIndex === undefined
      ? userIndexes
      : conversationIndexes.filter((index) => index >= boundaryStartIndex),
  );
  if (boundaryStartIndex === undefined) {
    for (const index of conversationIndexes.toReversed()) {
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= preserveTurns * 2) {
        break;
      }
    }
  }
  const preservedToolCallIds = new Set<string>();
  for (const index of preservedIndexSet) {
    const message = params.messages[index];
    if (message?.role === "assistant") {
      for (const toolCall of extractToolCallsFromAssistant(message)) {
        preservedToolCallIds.add(toolCall.id);
      }
    }
  }
  if (preservedToolCallIds.size > 0) {
    const preservedStartIndex = conversationIndexes.find((index) => preservedIndexSet.has(index))!;
    for (let index = preservedStartIndex; index < params.messages.length; index += 1) {
      const message = params.messages[index];
      if (message?.role !== "toolResult") {
        continue;
      }
      const toolResultId = extractToolResultId(message);
      if (toolResultId && preservedToolCallIds.has(toolResultId)) {
        preservedIndexSet.add(index);
      }
    }
  }
  const summarizableMessages: AgentMessage[] = [];
  const preservedMessages: AgentMessage[] = [];
  for (const [index, message] of params.messages.entries()) {
    (preservedIndexSet.has(index) ? preservedMessages : summarizableMessages).push(message);
  }
  // Preserving recent assistant turns can orphan downstream toolResult messages.
  // Repair pairings here so compaction summarization doesn't trip strict providers.
  return {
    summarizableMessages: repairToolUseResultPairing(summarizableMessages).messages,
    preservedMessages,
  };
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
      const rendered = [
        extractMessageText(message),
        formatNonTextPlaceholder((message as { content?: unknown }).content),
      ]
        .filter(Boolean)
        .join("\n");
      if (!rendered) {
        return null;
      }
      const trimmed =
        rendered.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : rendered;
      return `- ${roleLabel}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
}

function formatContextSection(messages: AgentMessage[], heading: string): string {
  const lines = formatContextMessages(messages);
  return lines.length > 0 ? `${heading}\n${lines.join("\n")}` : "";
}

function formatPreservedTurnsSection(messages: AgentMessage[]): string {
  return formatContextSection(messages, "\n\n## Recent turns preserved verbatim");
}

function formatSplitTurnContextSection(messages: AgentMessage[]): string {
  return formatContextSection(messages, "**Turn Context (split turn):**\n");
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
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
 * Uses explicitly configured AGENTS.md section names only.
 * The default "Session Startup" / "Red Lines" pair preserves the legacy
 * "Every Session" / "Safety" fallback.
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(
  sectionNames?: string[],
  workspaceDir = process.cwd(),
): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  if (!Array.isArray(sectionNames) || sectionNames.length === 0) {
    return "";
  }
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openRootFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return "";
    }

    let content: string;
    try {
      content = await readWorkspaceBootstrapFile(opened.fd);
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn(
          `Ignoring oversized AGENTS.md ${agentsPath}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
        );
        return "";
      }
      throw err;
    } finally {
      fs.closeSync(opened.fd);
    }
    let sections = extractSections(content, sectionNames);
    if (
      sections.length === 0 &&
      sectionNames.length === 2 &&
      sectionNames.some((name) => name.trim().toLowerCase() === "session startup") &&
      sectionNames.some((name) => name.trim().toLowerCase() === "red lines")
    ) {
      sections = extractSections(content, ["Every Session", "Safety"]);
    }

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? `${truncateUtf16Safe(combined, MAX_SUMMARY_CONTEXT_CHARS)}\n...[truncated]...`
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
}

/** Registers compaction hooks that summarize, preserve recent turns, and audit output quality. */
export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const {
      preparation,
      customInstructions: eventInstructions,
      signal,
      thinkingLevel,
      streamFn,
    } = event;
    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(
      preparation.messagesToSummarize,
    );
    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
    let hasRealSummarizable = containsRealConversation(baseMessagesToSummarize);
    let hasRealTurnPrefix = containsRealConversation(baseTurnPrefixMessages);
    if (!hasRealSummarizable && !hasRealTurnPrefix) {
      const branchMessages = filterReplayUnsafeSessionBranchMessages(
        stripRuntimeContextCustomMessages(collectSessionBranchMessages(ctx.sessionManager)),
      );
      if (containsRealConversation(branchMessages)) {
        log.info(
          "Compaction safeguard: using session branch messages after compaction preparation omitted real conversation content.",
        );
        baseMessagesToSummarize = branchMessages;
        baseTurnPrefixMessages = [];
        hasRealSummarizable = true;
        hasRealTurnPrefix = false;
      }
    }
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
    const structuredInstructions = buildCompactionStructureInstructions(
      customInstructions,
      summarizationInstructions,
    );
    const finalizeSummary = async (
      body: string,
      sections: { splitTurnSection?: string; preservedTurnsSection?: string },
    ) => ({
      compaction: {
        summary: capCompactionSummaryPreservingSuffix(
          body,
          assembleSuffix({
            ...sections,
            toolFailureSection,
            fileOpsSummary,
            workspaceContext: await readWorkspaceContextForSummary(
              runtime?.postCompactionSections,
              runtime?.workspaceDir,
            ),
          }),
        ),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { readFiles, modifiedFiles },
      },
    });

    if (providerId) {
      const compactionProvider: CompactionProvider | undefined = getCompactionProvider(providerId);
      if (compactionProvider) {
        try {
          // Give the provider ALL messages — no pruning, no chunking, no split-turn splitting.
          const providerResult = await compactionProvider.summarize({
            messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
            signal,
            customInstructions: structuredInstructions,
            summarizationInstructions,
            previousSummary: preparation.previousSummary,
          });
          if (typeof providerResult === "string" && providerResult.trim()) {
            const { preservedMessages } = splitPreservedRecentTurns({
              messages: baseMessagesToSummarize,
              recentTurnsPreserve,
            });
            return await finalizeSummary(providerResult, {
              splitTurnSection: preparation.isSplitTurn
                ? formatSplitTurnContextSection(turnPrefixMessages)
                : "",
              preservedTurnsSection: formatPreservedTurnsSection(preservedMessages),
            });
          }
          log.warn(
            `Compaction provider "${compactionProvider.id}" returned empty result, falling back to LLM.`,
          );
        } catch (err) {
          // Caller cancellation and real transport timeouts remain terminal.
          if (signal?.aborted || (!isAbortError(err) && isTimeoutError(err))) {
            throw err;
          }
          log.warn(
            `Compaction provider "${compactionProvider.id}" failed, falling back to LLM: ${formatErrorMessage(err)}`,
          );
        }
      } else {
        log.warn(
          `Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`,
        );
      }
    }

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
    try {
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      let messagesToSummarize = baseMessagesToSummarize;
      const headers = buildCompactionSummaryHeaders({
        model,
        messages: messagesToSummarize,
        headers: authResult.headers,
      });
      const llmSummaryParams = {
        model,
        apiKey: authResult.apiKey ?? "",
        headers,
        signal,
        reserveTokens: resolveSummaryReserveTokens(preparation.settings.reserveTokens, model),
        contextWindow: contextWindowTokens,
        summarizationInstructions,
        thinkingLevel,
        streamFn,
      };
      const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const prunePlan = buildHistoryPrunePlan({
          messagesToSummarize,
          turnPrefixMessages,
          tokensBefore,
          contextWindowTokens,
          maxHistoryShare,
          parts: 2,
        });
        const { newContentTokens, maxHistoryTokens, pruned } = prunePlan;

        if (newContentTokens > maxHistoryTokens && pruned) {
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
                const droppedChunkRatio = await computeAdaptiveChunkRatioWithWorker({
                  messages: pruned.droppedMessagesList,
                  contextWindow: contextWindowTokens,
                  signal,
                });
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeViaLLM({
                  ...llmSummaryParams,
                  messages: pruned.droppedMessagesList,
                  maxChunkTokens: droppedMaxChunkTokens,
                  customInstructions: structuredInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                if (signal?.aborted) {
                  signal.throwIfAborted();
                }
                throw new Error("Failed to summarize dropped messages.", {
                  cause: droppedError,
                });
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
      const preservedTurnsSectionLocal = formatPreservedTurnsSection(preservedRecentMessages);
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const latestUserAsk = extractLatestUserAsk(allMessages);
      const identifiers = extractOpaqueIdentifiers(
        allMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
      );

      // Use adaptive chunk ratio based on message sizes, reserving headroom for
      // the summarization prompt, system prompt, previous summary, and reasoning budget
      // that generateSummary adds on top of the serialized conversation chunk.
      const adaptiveRatio = await computeAdaptiveChunkRatioWithWorker({
        messages: allMessages,
        contextWindow: contextWindowTokens,
        signal,
      });
      const maxChunkTokens = Math.max(
        1,
        Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
      );
      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      let lastHistorySummary = "";
      let lastSplitTurnSection = "";
      let currentInstructions = structuredInstructions;
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      let lastSuccessfulSummary: string | null = null;

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let summaryWithoutPreservedTurns = "";
        let summaryWithPreservedTurns = "";
        let splitTurnSectionLocal = "";
        let historySummary = "";
        try {
          historySummary =
            messagesToSummarize.length > 0
              ? await summarizeViaLLM({
                  ...llmSummaryParams,
                  messages: messagesToSummarize,
                  maxChunkTokens,
                  customInstructions: currentInstructions,
                  previousSummary: effectivePreviousSummary,
                })
              : buildStructuredFallbackSummary(effectivePreviousSummary);

          summaryWithoutPreservedTurns = historySummary;
          if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
            const prefixSummary = await summarizeViaLLM({
              ...llmSummaryParams,
              messages: turnPrefixMessages,
              maxChunkTokens,
              customInstructions: `${TURN_PREFIX_INSTRUCTIONS}\n\nAdditional requirements:\n\n${currentInstructions}`,
              previousSummary: undefined,
            });
            splitTurnSectionLocal = `**Turn Context (split turn):**\n\n${prefixSummary}`;
            summaryWithoutPreservedTurns = historySummary.trim()
              ? `${historySummary}\n\n---\n\n${splitTurnSectionLocal}`
              : splitTurnSectionLocal;
          }
          summaryWithPreservedTurns = appendSummarySection(
            summaryWithoutPreservedTurns,
            preservedTurnsSectionLocal,
          );
        } catch (attemptError) {
          if (lastSuccessfulSummary && attempt > 0) {
            log.warn(
              `Compaction safeguard: quality retry failed on attempt ${attempt + 1}; ` +
                `keeping last successful summary: ${formatErrorMessage(attemptError)}`,
            );
            break;
          }
          throw attemptError;
        }
        lastSuccessfulSummary = summaryWithPreservedTurns;
        lastHistorySummary = historySummary;
        lastSplitTurnSection = splitTurnSectionLocal;

        const canRegenerate =
          messagesToSummarize.length > 0 ||
          (preparation.isSplitTurn && turnPrefixMessages.length > 0);
        if (!qualityGuardEnabled || !canRegenerate) {
          break;
        }
        const quality = auditSummaryQuality({
          summary: summaryWithoutPreservedTurns,
          identifiers,
          latestAsk: latestUserAsk,
          identifierPolicy,
        });
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

      // Cap history before suffixes so diagnostics and workspace rules survive.
      return await finalizeSummary(lastHistorySummary || lastSuccessfulSummary || "", {
        splitTurnSection: lastSplitTurnSection,
        preservedTurnsSection: preservedTurnsSectionLocal,
      });
    } catch (error) {
      // Caller cancellation is terminal, not a safeguard failure. Preserve the
      // original abort so the runner can classify it without a false data-loss warning.
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
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

const testing = {
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

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.compactionSafeguardTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
