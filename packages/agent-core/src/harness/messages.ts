// Agent Core module implements messages behavior.
import type { ImageContent, Message, TextContent } from "@openclaw/llm-core";
import type {
  AgentMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "../types.js";

export type {
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "../types.js";

/** Harness-only transcript entries that can be normalized into LLM messages. */
export type HarnessMessage =
  | AgentMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

// Internal session paths keep call sites explicit about this harness-owned
// boundary even though these message roles are part of AgentMessage.
export function asAgentMessage(message: HarnessMessage): AgentMessage {
  return message as AgentMessage;
}

function parseSessionTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireSessionTimestampMs(value: string, label: string): number {
  const parsed = parseSessionTimestampMs(value);
  if (parsed === undefined) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeCompactionSummaryTimestamp(timestamp: number | string): number {
  if (typeof timestamp === "number") {
    return timestamp;
  }
  const parsed = parseSessionTimestampMs(timestamp);
  // Corrupt persisted rows should not abort context conversion; session order is already preserved.
  return parsed ?? 0;
}

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** Render a shell execution record as user-visible context text for the model. */
export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

/** Build a persisted branch summary message from the repository timestamp string. */
export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): BranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    timestamp: requireSessionTimestampMs(timestamp, "branch summary timestamp"),
  };
}

/** Build a persisted compaction summary message from the repository timestamp string. */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: requireSessionTimestampMs(timestamp, "compaction summary timestamp"),
  };
}

/** Build a custom transcript message that can be shown and replayed into context. */
export function createCustomMessage(
  customType: string,
  content: string | (TextContent | ImageContent)[],
  display: boolean,
  details: unknown,
  timestamp: string,
): CustomMessage {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: requireSessionTimestampMs(timestamp, "custom message timestamp"),
  };
}

/** Convert harness transcript messages into the LLM-facing message sequence. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      const message = m as HarnessMessage;
      switch (message.role) {
        case "bashExecution":
          if (message.excludeFromContext) {
            return undefined;
          }
          return {
            role: "user",
            content: [{ type: "text", text: bashExecutionToText(message) }],
            timestamp: message.timestamp,
          };
        case "custom": {
          const content =
            typeof message.content === "string"
              ? [{ type: "text" as const, text: message.content }]
              : message.content;
          // Transient current-turn runtime-context carriers must not anchor a
          // provider prompt-cache breakpoint (their bytes change every turn).
          const runtimeContextCarrier =
            (message.details as { runtimeContextCarrier?: unknown } | undefined)
              ?.runtimeContextCarrier === true;
          return {
            role: "user",
            content,
            timestamp: message.timestamp,
            ...(runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
          };
        }
        case "branchSummary":
          return {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          };
        case "compactionSummary":
          return {
            role: "user",
            content: [
              {
                type: "text" as const,
                text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: normalizeCompactionSummaryTimestamp(message.timestamp),
          };
        case "user":
        case "assistant":
        case "toolResult":
          return message;
        default:
          return undefined;
      }
    })
    .filter((m): m is Message => m !== undefined);
}
