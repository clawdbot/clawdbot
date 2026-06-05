// Agent Core helper module supports utils behavior.
import type { Message } from "../../../../llm-core/src/index.js";
import type { AgentMessage } from "../../types.js";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
  /** Files read but not necessarily modified. */
  read: Set<string>;
  /** Files written by full-file write operations. */
  written: Set<string>;
  /** Files modified by edit operations. */
  edited: Set<string>;
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
  return {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") {
    return;
  }
  if (!("content" in message) || !Array.isArray(message.content)) {
    return;
  }

  for (const block of message.content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    if (!("type" in block) || block.type !== "toolCall") {
      continue;
    }
    if (!("arguments" in block) || !("name" in block)) {
      continue;
    }

    const args = block.arguments as Record<string, unknown> | undefined;
    if (!args) {
      continue;
    }

    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) {
      continue;
    }

    switch (block.name) {
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

/** Format file lists as summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
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
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
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
          const args = block.arguments;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
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
      const content = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  return parts.join("\n\n");
}
