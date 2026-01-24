/**
 * Session JSONL Parser
 *
 * Parses Claude Code session .jsonl files and extracts events.
 */

import fs from "node:fs";
import type { SessionEvent } from "../types.js";

/**
 * Session parser that tracks file position for incremental reads.
 */
export class SessionParser {
  private sessionFile: string;
  private lastPosition: number = 0;
  private eventCount: number = 0;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  /**
   * Parse all events in the session file.
   */
  parseAll(): SessionEvent[] {
    if (!fs.existsSync(this.sessionFile)) {
      return [];
    }

    const content = fs.readFileSync(this.sessionFile, "utf8");
    const events: SessionEvent[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const raw = JSON.parse(trimmed);
        const event = this.parseEvent(raw);
        if (event) {
          events.push(event);
          this.eventCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    this.lastPosition = content.length;
    return events;
  }

  /**
   * Parse only new events since last read.
   */
  parseNew(): SessionEvent[] {
    if (!fs.existsSync(this.sessionFile)) {
      return [];
    }

    const stat = fs.statSync(this.sessionFile);
    if (stat.size <= this.lastPosition) {
      return []; // No new data
    }

    // Read new content
    const fd = fs.openSync(this.sessionFile, "r");
    const buffer = Buffer.alloc(stat.size - this.lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, this.lastPosition);
    fs.closeSync(fd);

    this.lastPosition = stat.size;

    const events: SessionEvent[] = [];
    for (const line of buffer.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const raw = JSON.parse(trimmed);
        const event = this.parseEvent(raw);
        if (event) {
          events.push(event);
          this.eventCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return events;
  }

  /**
   * Get total events parsed.
   */
  getEventCount(): number {
    return this.eventCount;
  }

  /**
   * Reset parser position (re-read from start).
   */
  reset(): void {
    this.lastPosition = 0;
    this.eventCount = 0;
  }

  /**
   * Skip to end of file (ignore existing content, only read new events).
   * Useful when resuming a session where we don't want to replay history.
   */
  skipToEnd(): void {
    if (!fs.existsSync(this.sessionFile)) {
      return;
    }
    const stat = fs.statSync(this.sessionFile);
    this.lastPosition = stat.size;
  }

  /**
   * Parse a single raw event dict into a SessionEvent.
   */
  private parseEvent(raw: Record<string, unknown>): SessionEvent | undefined {
    const eventType = raw.type as string;
    const timestamp = raw.timestamp ? new Date(raw.timestamp as string) : new Date();

    if (eventType === "assistant") {
      return this.parseAssistantEvent(raw, timestamp);
    } else if (eventType === "user") {
      return this.parseUserEvent(raw, timestamp);
    } else if (eventType === "summary") {
      return this.parseSummaryEvent(raw, timestamp);
    } else if (eventType === "system") {
      return {
        type: "system",
        timestamp,
        text: (raw.text as string) || "",
        raw,
      };
    }

    return undefined;
  }

  /**
   * Parse an assistant message event.
   */
  private parseAssistantEvent(raw: Record<string, unknown>, timestamp: Date): SessionEvent {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      return {
        type: "assistant_message",
        timestamp,
        raw,
      };
    }

    const content = message.content as Array<Record<string, unknown>> | undefined;
    const texts: string[] = [];
    const toolNames: string[] = [];
    const toolInputs: string[] = [];
    let isToolUse = false;

    // Extract stop_reason
    const stopReason = message.stop_reason as string | undefined;

    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;

        const itemType = item.type as string;

        if (itemType === "text") {
          texts.push((item.text as string) || "");
        } else if (itemType === "tool_use") {
          isToolUse = true;
          toolNames.push((item.name as string) || "unknown");

          // Extract tool input (file_path, command, pattern, etc.)
          const toolInput = item.input as Record<string, unknown> | undefined;
          if (toolInput && typeof toolInput === "object") {
            const inputStr =
              (toolInput.file_path as string) ||
              (toolInput.path as string) ||
              (toolInput.command as string) ||
              (toolInput.pattern as string) ||
              (toolInput.prompt as string) ||
              "";
            toolInputs.push(inputStr);
          }
        }
      }
    }

    const text = texts.join("\n");

    if (isToolUse) {
      return {
        type: "tool_use",
        timestamp,
        text,
        toolName: toolNames.join(", ") || undefined,
        toolInput: toolInputs[0] || undefined,
        isWaitingForInput: false,
        raw,
      };
    }

    // Determine if waiting for input based on stop_reason
    const isWaitingForInput = stopReason === "end_turn" || stopReason === "stop_sequence";

    return {
      type: "assistant_message",
      timestamp,
      text,
      isWaitingForInput,
      raw,
    };
  }

  /**
   * Parse a user message event.
   */
  private parseUserEvent(raw: Record<string, unknown>, timestamp: Date): SessionEvent {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      return {
        type: "user_message",
        timestamp,
        raw,
      };
    }

    const content = message.content;

    // Handle string content (direct user prompts)
    if (typeof content === "string") {
      return {
        type: "user_message",
        timestamp,
        text: content.trim(),
        raw,
      };
    }

    // Handle array content (tool results or structured messages)
    if (Array.isArray(content)) {
      // Check if it's a tool result
      for (const item of content) {
        if (
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).type === "tool_result"
        ) {
          const resultContent = (item as Record<string, unknown>).content;
          let text = "";

          if (typeof resultContent === "string") {
            text = resultContent.slice(0, 500);
          } else if (Array.isArray(resultContent)) {
            text = resultContent
              .map((c) =>
                c && typeof c === "object" ? (c as Record<string, unknown>).text || "" : "",
              )
              .join("\n")
              .slice(0, 500);
          }

          return {
            type: "tool_result",
            timestamp,
            text,
            raw,
          };
        }
      }

      // Regular user message with array content
      const texts: string[] = [];
      for (const item of content) {
        if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
          texts.push(((item as Record<string, unknown>).text as string) || "");
        }
      }

      return {
        type: "user_message",
        timestamp,
        text: texts.join("\n"),
        raw,
      };
    }

    return {
      type: "user_message",
      timestamp,
      raw,
    };
  }

  /**
   * Parse a summary event.
   */
  private parseSummaryEvent(raw: Record<string, unknown>, timestamp: Date): SessionEvent {
    return {
      type: "summary",
      timestamp,
      text: (raw.summary as string) || "Context summarized",
      raw,
    };
  }
}

/**
 * Extract recent actions from events for display.
 */
export function extractRecentActions(
  events: SessionEvent[],
  limit: number = 10,
): Array<{ icon: string; description: string; fullText?: string }> {
  const actions: Array<{ icon: string; description: string; fullText?: string }> = [];

  // Get last N events
  const recentEvents = events.slice(-limit * 2); // Get more to filter

  for (const event of recentEvents) {
    let action: { icon: string; description: string; fullText?: string } | undefined;

    switch (event.type) {
      case "tool_use":
        action = {
          icon: "▸",
          description: formatToolUseDescription(event.toolName, event.toolInput),
        };
        break;

      case "tool_result":
        action = {
          icon: "✓",
          description: formatToolResultDescription(event.toolName, event.text),
        };
        break;

      case "assistant_message":
        if (event.isWaitingForInput && event.text) {
          action = {
            icon: "❓",
            description: truncate(event.text, 50),
            fullText: event.text,
          };
        } else if (event.text) {
          action = {
            icon: "💬",
            description: truncate(event.text, 50),
            fullText: event.text,
          };
        }
        break;

      case "user_message":
        if (event.text) {
          action = {
            icon: "👤",
            description: truncate(event.text, 45),
          };
        }
        break;

      case "summary":
        action = {
          icon: "📋",
          description: "Context summarized",
        };
        break;
    }

    if (action) {
      actions.push(action);
    }
  }

  return actions.slice(-limit);
}

/**
 * Get the most recent event where Claude is waiting for input.
 */
export function getWaitingEvent(events: SessionEvent[]): SessionEvent | undefined {
  // Check only the last assistant event
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "assistant_message") {
      if (event.isWaitingForInput) {
        return event;
      }
      break; // Only check the last assistant message
    }
  }
  return undefined;
}

/**
 * Determine session idle state from events.
 */
export function isSessionIdle(events: SessionEvent[]): boolean {
  if (events.length === 0) return true;

  const lastEvent = events[events.length - 1];
  return (
    lastEvent.type === "tool_result" ||
    lastEvent.type === "assistant_message" ||
    lastEvent.type === "summary"
  );
}

/**
 * Format tool use description for display.
 */
function formatToolUseDescription(toolName?: string, toolInput?: string): string {
  const name = toolName?.toLowerCase() ?? "tool";

  if (name.includes("read")) {
    const file = extractFilename(toolInput);
    return file ? `Reading ${file}` : "Reading file";
  }
  if (name.includes("write")) {
    const file = extractFilename(toolInput);
    return file ? `Writing ${file}` : "Writing file";
  }
  if (name.includes("edit")) {
    const file = extractFilename(toolInput);
    return file ? `Editing ${file}` : "Editing file";
  }
  if (name.includes("bash")) {
    if (toolInput) {
      const cmd = toolInput.split(/\s+/)[0];
      return cmd ? `Running: ${truncate(cmd, 20)}` : "Running command";
    }
    return "Running command";
  }
  if (name.includes("grep")) {
    return "Searching code";
  }
  if (name.includes("glob")) {
    return "Finding files";
  }
  if (name.includes("task")) {
    return "Running subagent";
  }
  if (name.includes("web")) {
    return "Fetching web content";
  }

  return toolName ?? "Tool";
}

/**
 * Format tool result description for display.
 */
function formatToolResultDescription(toolName?: string, text?: string): string {
  const name = toolName?.toLowerCase() ?? "tool";

  if (name.includes("read")) {
    const file = extractFilename(text);
    return file ? `Read ${file}` : "Read file";
  }
  if (name.includes("write")) {
    const file = extractFilename(text);
    return file ? `Wrote ${file}` : "Wrote file";
  }
  if (name.includes("edit")) {
    const file = extractFilename(text);
    return file ? `Edited ${file}` : "Edited file";
  }
  if (name.includes("bash")) {
    return "Ran command";
  }
  if (name.includes("grep")) {
    return "Searched code";
  }
  if (name.includes("glob")) {
    return "Found files";
  }
  if (name.includes("task")) {
    return "Subagent completed";
  }

  return `${toolName ?? "Tool"} done`;
}

/**
 * Extract filename from path or text.
 */
function extractFilename(text?: string): string | undefined {
  if (!text) return undefined;

  // Try to find a path
  const match = text.match(/([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/);
  if (match) {
    const parts = match[1].split("/");
    const filename = parts[parts.length - 1];
    return filename.length > 25 ? filename.slice(0, 22) + "..." : filename;
  }
  return undefined;
}

/**
 * Truncate text with ellipsis.
 */
function truncate(text: string, maxLen: number): string {
  if (!text) return "";

  // Clean up the text
  let cleaned = text.trim();
  // Remove markdown formatting
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  // Remove leading symbols
  cleaned = cleaned.replace(/^[#\-*]+\s*/, "");
  // Take first line only
  cleaned = cleaned.split("\n")[0].trim();

  if (cleaned.length <= maxLen) {
    return cleaned;
  }

  // Truncate at word boundary if possible
  let truncated = cleaned.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen - 15) {
    truncated = truncated.slice(0, lastSpace);
  }

  return truncated.replace(/[.,;:]+$/, "") + "...";
}
