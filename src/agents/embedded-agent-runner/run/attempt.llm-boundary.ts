import { stripInboundMetadata } from "../../../auto-reply/reply/strip-inbound-meta.js";
import { stripHistoricalRuntimeContextCustomMessages } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import { markTranscriptPromptText } from "../tool-result-context-guard.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

export function normalizeMessagesForLlmBoundary(messages: AgentMessage[]): AgentMessage[] {
  const normalized = stripUnsafeBlockedRunMetadata(
    stripToolResultDetails(normalizeAssistantReplayContent(messages)),
  );
  const withoutHistoricalInboundMetadata =
    stripHistoricalInboundMetadataFromUserMessages(normalized);
  return stripHistoricalRuntimeContextCustomMessages(withoutHistoricalInboundMetadata);
}

export function normalizeMessagesForCurrentPromptBoundary(params: {
  messages: AgentMessage[];
  prompt: string;
}): AgentMessage[] {
  const promptMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: params.prompt }],
    timestamp: Date.now(),
  };
  return normalizeMessagesForLlmBoundary([...params.messages, promptMessage]).slice(0, -1);
}

export function installRuntimeContextMessageForPrompt(params: {
  session: {
    messages: AgentMessage[];
    agent: {
      state: { messages: AgentMessage[] };
      continue?: () => Promise<void>;
    };
  };
  message?: RuntimeContextCustomMessage;
}): () => void {
  const { message, session } = params;
  if (!message) {
    return () => undefined;
  }
  const installBeforePrompt = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = appendRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  const installBeforeRetry = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = insertRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  installBeforePrompt();
  const agent = session.agent;
  const originalContinue = Reflect.get(agent, "continue", agent) as unknown;
  if (typeof originalContinue === "function") {
    const continueWithAgent = originalContinue.bind(agent) as () => Promise<void>;
    agent.continue = function continueWithRuntimeContext(this: typeof agent): Promise<void> {
      // Pi overflow recovery can rebuild state from the persisted branch before retrying.
      installBeforeRetry();
      return continueWithAgent();
    };
  }
  return () => {
    if (typeof originalContinue === "function") {
      agent.continue = originalContinue as typeof agent.continue;
    }
    session.agent.state.messages = session.messages.filter((candidate) => candidate !== message);
  };
}

function appendRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  return [...params.messages, params.message];
}

export function insertRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(params.messages);
  if (activeUserMessageIndex === -1) {
    return [...params.messages, params.message];
  }
  return [
    ...params.messages.slice(0, activeUserMessageIndex),
    params.message,
    ...params.messages.slice(activeUserMessageIndex),
  ];
}

function replaceLastUserTextPrompt(params: {
  messages: AgentMessage[];
  shouldCapture?: (message: AgentMessage) => boolean;
  transcriptText?: string;
  replace: (text: string) => string | undefined;
}): AgentMessage[] {
  const userIndex = params.messages.findLastIndex((message) => message.role === "user");
  if (userIndex === -1) {
    return params.messages;
  }
  const message = params.messages[userIndex];
  if (!message || message.role !== "user") {
    return params.messages;
  }
  if (params.shouldCapture && !params.shouldCapture(message)) {
    return params.messages;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const replacement = params.replace(content);
    if (replacement === undefined) {
      return params.messages;
    }
    const next = params.messages.slice();
    next[userIndex] = { ...message, content: replacement } as AgentMessage;
    if (params.transcriptText !== undefined) {
      markTranscriptPromptText(next[userIndex], params.transcriptText);
    }
    return next;
  }
  if (!Array.isArray(content)) {
    return params.messages;
  }
  let replaced = false;
  const nextContent = content.map((block) => {
    if (replaced || !block || typeof block !== "object") {
      return block;
    }
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
      return block;
    }
    const replacement = params.replace(textBlock.text);
    if (replacement === undefined) {
      return block;
    }
    replaced = true;
    return Object.assign({}, block, { text: replacement });
  });
  if (!replaced) {
    return params.messages;
  }
  const next = params.messages.slice();
  next[userIndex] = { ...message, content: nextContent } as AgentMessage;
  if (params.transcriptText !== undefined) {
    markTranscriptPromptText(next[userIndex], params.transcriptText);
  }
  return next;
}

function composeModelPromptContext(params: {
  prompt: string;
  prependContext?: string;
  appendContext?: string;
}): string {
  return [params.prependContext, params.prompt, params.appendContext]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

export function installModelPromptTransform(params: {
  session: {
    agent: {
      transformContext?: (
        messages: AgentMessage[],
        signal?: AbortSignal,
      ) => Promise<AgentMessage[]>;
    };
  };
  transcriptPrompt: string;
  modelPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  shouldCapturePrompt: () => boolean;
}): () => void {
  const modelPrompt = params.modelPrompt;
  const hasPromptContext =
    Boolean(params.prependContext?.trim()) || Boolean(params.appendContext?.trim());
  if ((!modelPrompt?.trim() || modelPrompt === params.transcriptPrompt) && !hasPromptContext) {
    return () => undefined;
  }
  const agent = params.session.agent;
  const originalTransformContext = agent.transformContext;
  let targetPromptTimestamp: number | undefined;
  agent.transformContext = async (messages, signal) => {
    const promptMessages = replaceLastUserTextPrompt({
      messages,
      transcriptText: params.transcriptPrompt,
      shouldCapture: (message) => {
        const timestamp = (message as { timestamp?: unknown }).timestamp;
        if (targetPromptTimestamp !== undefined) {
          return timestamp === targetPromptTimestamp;
        }
        if (!params.shouldCapturePrompt()) {
          return false;
        }
        if (typeof timestamp === "number") {
          targetPromptTimestamp = timestamp;
        }
        return true;
      },
      replace: (text) => {
        if (modelPrompt?.trim() && text === params.transcriptPrompt) {
          return modelPrompt;
        }
        if (!hasPromptContext) {
          return undefined;
        }
        const replacement = composeModelPromptContext({
          prompt: text,
          prependContext: params.prependContext,
          appendContext: params.appendContext,
        });
        return replacement === text ? undefined : replacement;
      },
    });
    return originalTransformContext
      ? await originalTransformContext.call(agent, promptMessages, signal)
      : promptMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}

function stripHistoricalInboundMetadataFromUserMessages(messages: AgentMessage[]): AgentMessage[] {
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user" || index === activeUserMessageIndex) {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      const stripped = stripInboundMetadata(content);
      if (stripped === content) {
        return message;
      }
      changed = true;
      return { ...message, content: stripped } as AgentMessage;
    }
    if (!Array.isArray(content)) {
      return message;
    }
    let contentChanged = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
        return block;
      }
      const stripped = stripInboundMetadata(textBlock.text);
      if (stripped === textBlock.text) {
        return block;
      }
      contentChanged = true;
      return Object.assign({}, block, { text: stripped });
    });
    if (!contentChanged) {
      return message;
    }
    changed = true;
    return { ...message, content: nextContent } as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function stripUnsafeBlockedRunMetadata(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const openclaw = (message as unknown as Record<string, unknown>)["__openclaw"];
    if (!openclaw || typeof openclaw !== "object") {
      return message;
    }
    const beforeAgentRunBlocked = (openclaw as { beforeAgentRunBlocked?: unknown })
      .beforeAgentRunBlocked;
    if (!beforeAgentRunBlocked || typeof beforeAgentRunBlocked !== "object") {
      return message;
    }
    const blocked = beforeAgentRunBlocked as Record<string, unknown>;
    const safeBlocked: Record<string, unknown> = {};
    if (typeof blocked.blockedBy === "string") {
      safeBlocked.blockedBy = blocked.blockedBy;
    }
    if (typeof blocked.blockedAt === "number") {
      safeBlocked.blockedAt = blocked.blockedAt;
    }
    const nextOpenClaw = {
      ...(openclaw as Record<string, unknown>),
      beforeAgentRunBlocked: safeBlocked,
    };
    changed = true;
    return {
      ...(message as unknown as Record<string, unknown>),
      __openclaw: nextOpenClaw,
    } as unknown as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function findActiveUserMessageIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return index;
    }
    if (message.role === "assistant" && !isToolCallAssistantMessage(message)) {
      return -1;
    }
  }
  return -1;
}

function isToolCallAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "toolUse" || type === "functionCall";
  });
}
