import type { AssistantMessage, AssistantMessageEvent, Model } from "@openclaw/llm-core";
import {
  processResponsesStream as processTransportStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

type ProjectedEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
};

type ProjectedBlock =
  | { type: "thinking"; thinking: string; encrypted: boolean }
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson: boolean;
    };

type ProcessResult = {
  events: ProjectedEvent[];
  content: ProjectedBlock[];
  responseId: string | null;
  stopReason: string;
  error: string | null;
};

export type ParityFixture = {
  name: string;
  events: Record<string, unknown>[];
  canonical: ProcessResult;
};

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* eventStream(
  events: readonly Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const event of events) {
    yield event as OpenAIResponsesStreamEvent;
  }
}

function projectEvent(event: AssistantMessageEvent): ProjectedEvent | undefined {
  if (
    event.type !== "thinking_start" &&
    event.type !== "thinking_delta" &&
    event.type !== "thinking_end" &&
    event.type !== "text_start" &&
    event.type !== "text_delta" &&
    event.type !== "text_end" &&
    event.type !== "toolcall_start" &&
    event.type !== "toolcall_delta" &&
    event.type !== "toolcall_end"
  ) {
    return undefined;
  }
  return {
    type: event.type,
    contentIndex: event.contentIndex,
    ...(event.type === "thinking_delta" ||
    event.type === "text_delta" ||
    event.type === "toolcall_delta"
      ? { delta: event.delta }
      : {}),
    ...(event.type === "thinking_end" || event.type === "text_end"
      ? { content: event.content }
      : {}),
  };
}

function projectBlock(block: AssistantMessage["content"][number]): ProjectedBlock {
  if (block.type === "thinking") {
    let encrypted = false;
    if (block.thinkingSignature) {
      try {
        const item = JSON.parse(block.thinkingSignature) as { encrypted_content?: unknown };
        encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      } catch {
        encrypted = false;
      }
    }
    return { type: "thinking", thinking: block.thinking, encrypted };
  }
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  const toolCall = block as typeof block & { partialJson?: string };
  return {
    type: "toolCall",
    id: toolCall.id.replace(/^call_[a-f0-9]{24}/, "call_<generated>"),
    name: toolCall.name,
    arguments: toolCall.arguments,
    partialJson: "partialJson" in toolCall,
  };
}

export async function runFixture(
  events: readonly Record<string, unknown>[],
): Promise<ProcessResult> {
  const output = createOutput();
  const captured: AssistantMessageEvent[] = [];
  let error: string | null = null;
  try {
    await processTransportStream(
      eventStream(events),
      output,
      { push: (event) => captured.push(event as AssistantMessageEvent) },
      model,
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    events: captured.map(projectEvent).filter((event) => event !== undefined),
    content: output.content.map(projectBlock),
    responseId: output.responseId ?? null,
    stopReason: output.stopReason,
    error,
  };
}

export const completed = (id: string, output: unknown[] = []) => ({
  type: "response.completed",
  sequence_number: 99,
  response: { id, status: "completed", output },
});
