/**
 * Builds and installs embedded-agent system prompts.
 */
import type { ChatType } from "../../channels/chat-type.js";
import type { AgentTool } from "../runtime/index.js";
import type { AgentSession } from "../sessions/index.js";
import { buildConfiguredAgentSystemPrompt } from "../system-prompt-config.js";
import type { SystemPromptRuntimeInfo } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Omit<
  Parameters<typeof buildConfiguredAgentSystemPrompt>[0],
  "toolNames" | "toolSummaries" | "requireExplicitMessageTarget" | "fsWorkspaceOnly"
> & {
  reasoningTagHint: boolean;
  runtimeInfo: SystemPromptRuntimeInfo & {
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    chatType?: ChatType;
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
  };
  tools: AgentTool[];
  userTimezone: string;
  userDate: string;
};

export function buildEmbeddedSystemPrompt(params: EmbeddedSystemPromptParams): string {
  const { tools, ...promptParams } = params;
  return buildConfiguredAgentSystemPrompt({
    ...promptParams,
    agentId: params.agentId ?? params.runtimeInfo.agentId,
    toolNames: tools.map((tool) => tool.name),
  });
}

export function applySystemPromptToSession(session: AgentSession, systemPrompt: string) {
  session.setBaseSystemPrompt(systemPrompt.trim());
}
