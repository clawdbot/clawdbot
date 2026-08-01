import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

function importedClaudeMessage(
  item: ClaudeTranscriptItem,
  fallbackTimestamp: number,
): AgentMessage | undefined {
  const parsedTimestamp = item.timestamp ? Date.parse(item.timestamp) : Number.NaN;
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackTimestamp;
  const importedText = item.text?.trim();
  if (!importedText && item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported Claude transcript item]";
  if (item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated native prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: "claude-catalog-import" },
    } as AgentMessage;
  }
  const prefix =
    item.type === "reasoning"
      ? "Thinking\n\n"
      : item.type === "toolCall"
        ? "Tool call\n\n"
        : item.type === "toolResult"
          ? "Tool result\n\n"
          : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `${prefix}${text}` }],
    timestamp,
    api: "anthropic-messages",
    provider: CLAUDE_CLI_BACKEND_ID,
    model: "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

export async function importClaudeHistory(params: {
  items: ClaudeTranscriptItem[];
  threadId: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = params.items.toReversed();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedClaudeMessage(item, Date.now() + index);
      if (!imported) {
        continue;
      }
      // The idempotency key rides on the message so recovery re-imports dedupe.
      const message = {
        ...(imported as unknown as Record<string, unknown>),
        idempotencyKey: `claude-catalog:${params.threadId}:${item.uuid ?? index}`,
      } as unknown as AgentMessage;
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}
