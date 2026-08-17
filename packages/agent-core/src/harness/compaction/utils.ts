import type { AssistantMessage, Message } from "@openclaw/llm-core";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import type { FileOperations } from "../types.js";

export type { FileOperations } from "../types.js";

function normalizeFileToolName(value: unknown): string {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  const separator = name.indexOf("__", name.startsWith("mcp__") ? 5 : 0);
  return separator < 0 ? name : name.slice(separator + 2);
}

function addFilePaths(target: Set<string>, value: unknown): void {
  for (const path of Array.isArray(value) ? value : []) {
    if (typeof path === "string") {
      target.add(path);
    }
  }
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Restore file metadata recorded by an earlier compaction or branch summary. */
export function mergeSummaryFileOperations(
  fileOps: FileOperations,
  details: { readFiles: string[]; modifiedFiles: string[] },
): void {
  addFilePaths(fileOps.read, details.readFiles);
  addFilePaths(fileOps.edited, details.modifiedFiles);
}

/** Add file operations from tool calls and results to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role === "toolResult") {
    if (normalizeFileToolName(message.toolName) !== "apply_patch") {
      return;
    }
    for (const result of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const details = asRecord(asRecord(result)?.details);
      const summary = asRecord(details?.summary);
      addFilePaths(fileOps.written, summary?.added);
      addFilePaths(fileOps.edited, summary?.modified);
    }
    // Deleted paths no longer exist for a continuation to inspect, so omit them.
    return;
  }

  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    const toolCall = asRecord(block);
    if (toolCall?.type !== "toolCall") {
      continue;
    }
    const args = asRecord(toolCall.arguments);
    const path = [args?.path, args?.file_path, args?.filePath].find(
      (value): value is string => typeof value === "string",
    );
    if (!path) {
      continue;
    }
    switch (normalizeFileToolName(toolCall.name)) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles: readOnly, modifiedFiles };
}

// File lists ratchet across compactions (prior summary entries merge into the
// next accumulation), so an unbounded join grows without limit in long
// sessions. Hard caps keep the model-visible section bounded per the
// context-budget invariant; overflow collapses to a "...and N more" line.
export const MAX_FILE_OPS_SECTION_CHARS = 2_000;
export const MAX_FILE_OPS_LIST_CHARS = 900;

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

  return lines.length > 0 ? `${openTag}${lines.join("").trimEnd()}${closeTag}` : "";
}

/** Format file lists as bounded summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections = [
    formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS),
    formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS),
  ].filter(Boolean);
  if (sections.length === 0) {
    return "";
  }
  const joined = `\n\n${sections.join("\n\n")}`;
  return joined.length > MAX_FILE_OPS_SECTION_CHARS
    ? joined.slice(0, MAX_FILE_OPS_SECTION_CHARS)
    : joined;
}

/** Extract visible summary text without normalizing valid model output. */
export function extractSummaryText(response: AssistantMessage): string | undefined {
  const summary = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return summary.trim() ? summary : undefined;
}

const TOOL_RESULT_MAX_CHARS = 2000;
const IMPORTANT_TOOL_RESULT_TAIL =
  /(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)/i;

export function stringifyCompactionValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const tailChars = Math.min(Math.floor(maxChars * 0.3), 600);
  const diagnosticSearch = sliceUtf16Safe(text, -maxChars);
  const diagnosticMatches = [
    ...diagnosticSearch.matchAll(new RegExp(IMPORTANT_TOOL_RESULT_TAIL.source, "gi")),
  ];
  const diagnosticMatch =
    diagnosticMatches.findLast((match) =>
      /^(error|exception|fatal|panic|errno)$/i.test(match[0]),
    ) ?? diagnosticMatches.at(-1);
  if (diagnosticMatch) {
    const head = truncateUtf16Safe(text, maxChars - tailChars);
    const displacedHead = sliceUtf16Safe(text, Math.max(0, head.length - 32), maxChars);
    // A routine footer can match failure words. Never shorten the original
    // retained head when doing so would discard an existing diagnostic.
    if (!IMPORTANT_TOOL_RESULT_TAIL.test(displacedHead)) {
      const diagnosticOffset = text.length - diagnosticSearch.length + (diagnosticMatch.index ?? 0);
      const tailStart = Math.min(diagnosticOffset, text.length - tailChars);
      // An early diagnostic already lives in the retained prefix; reusing it
      // as a tail would overlap the head and miscount omitted characters.
      if (tailStart >= head.length) {
        const tail = sliceUtf16Safe(text, tailStart, tailStart + tailChars);
        const truncatedChars = text.length - head.length - tail.length;
        const omissionPosition = tailStart + tail.length < text.length ? "middle/trailing" : "more";
        // Commands usually report their actual failure last; preserve that tail
        // so branch and ordinary compaction summaries can explain what failed.
        return `${head}\n\n[... ${truncatedChars} ${omissionPosition} characters truncated]\n\n${tail}`;
      }
    }
  }
  const sliced = truncateUtf16Safe(text, maxChars);
  const truncatedChars = text.length - sliced.length;
  return `${sliced}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Extract text that compaction both estimates and includes in summary prompts. */
export function getCompactionContentBlockText(block: {
  type: string;
  content?: unknown;
  text?: string;
}): string {
  if (
    (block.type === "text" || block.type === "toolResult" || block.type === "tool_result") &&
    block.text
  ) {
    return block.text;
  }
  return (block.type === "toolResult" || block.type === "tool_result") &&
    typeof block.content === "string"
    ? block.content
    : "";
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map(getCompactionContentBlockText).join("");
      if (content) {
        parts.push(`[User]: ${content}`);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const argsStr = Object.entries(block.arguments)
            .map(([k, v]) => `${k}=${stringifyCompactionValue(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content.map(getCompactionContentBlockText).join("");
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  return parts.join("\n\n");
}
