import { randomUUID } from "node:crypto";
import type { SDKUserMessage as ClaudeAgentSdkUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";

export function splitClaudeToolNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function createClaudeAgentSdkUserMessage(
  context: CliBackendExecuteContext,
): ClaudeAgentSdkUserMessage {
  return {
    type: "user",
    message: { role: "user", content: context.prompt },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}
