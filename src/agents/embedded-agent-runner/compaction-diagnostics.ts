/** Diagnostic helpers for embedded-agent compaction. */
import type { ApiRegistry } from "@openclaw/ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import type { AgentMessage } from "../runtime/index.js";
import { estimateTokens } from "../sessions/index.js";
import type { CompactionMessageMetrics } from "./compact.types.js";

export const hasRealConversationContent = isRealConversationMessage;

export function createDirectCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

export function resolveCompactionProviderStream(params: {
  effectiveModel: ProviderRuntimeModel;
  config?: OpenClawConfig;
  agentDir: string;
  effectiveWorkspace: string;
  apiRegistry: ApiRegistry;
}) {
  return registerProviderStreamForModel({
    model: params.effectiveModel,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.effectiveWorkspace,
    apiRegistry: params.apiRegistry,
  });
}

export function normalizeObservedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function getMessageTextChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  return Array.isArray(content)
    ? content.reduce((total, block) => {
        const text =
          block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
        return total + (typeof text === "string" ? text.length : 0);
      }, 0)
    : 0;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

export function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens = 0;
  let tokenEstimationFailed = false;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });
    if (!tokenEstimationFailed) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        tokenEstimationFailed = true;
      }
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens: tokenEstimationFailed ? undefined : estTokens,
    contributors: contributors.toSorted((left, right) => right.chars - left.chars).slice(0, 3),
  };
}

export function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    hasRealConversationContent(message, allMessages, index),
  );
}
