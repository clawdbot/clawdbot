import { createHash } from "node:crypto";
import type { CompactionForegroundContext } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { Context, Model } from "../llm/types.js";
import { convertToLlm } from "./sessions/messages.js";

type PrefixBoundaryOptions = {
  timezone?: string;
  includeTimestamp?: boolean;
  appendOnlyRuntimeContext?: boolean;
};

/** Session-owned prefix data, without transcript bodies or executable tools. */
export type CompactionPrefixSnapshot = {
  model: CompactionForegroundContext["model"];
  systemPrompt?: string;
  tools: Context["tools"];
  messageDigests: string[];
  boundaryOptions?: PrefixBoundaryOptions;
};

const messageDigest = (message: Context["messages"][number]) =>
  createHash("sha256").update(JSON.stringify(message)).digest("hex");

export function captureCompactionPrefix(
  model: Model,
  context: Context,
  boundaryOptions?: PrefixBoundaryOptions,
): CompactionPrefixSnapshot | undefined {
  if (
    (model.api !== "anthropic-messages" && model.api !== "openai-responses") ||
    context.messages.length > 4096
  ) {
    return undefined;
  }
  const tools = context.tools?.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  // The existing session LRU holds at most 64 entries. Bound retained schemas
  // separately; transcript bodies are hashed and never pinned by this cache.
  if (Buffer.byteLength(JSON.stringify([context.systemPrompt, tools])) > 256 * 1024) {
    return undefined;
  }
  return {
    model: { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl },
    systemPrompt: context.systemPrompt,
    tools: tools && structuredClone(tools),
    messageDigests: context.messages.map(messageDigest),
    boundaryOptions,
  };
}

/** Only an unchanged leading history range can reuse the foreground cache. */
export async function resolveCompactionPrefix(
  snapshot: CompactionPrefixSnapshot | undefined,
  messages: AgentMessage[],
): Promise<CompactionForegroundContext | undefined> {
  if (!snapshot || messages.length === 0) {
    return undefined;
  }
  // Session construction also consumes this module; load its replay projector
  // only once the compaction owner is running, after session initialization.
  const projected = snapshot.boundaryOptions
    ? (
        await import("./embedded-agent-runner/run/attempt-llm-boundary.js")
      ).normalizeMessagesForLlmBoundary(messages, snapshot.boundaryOptions)
    : messages;
  const nativeMessages = convertToLlm(projected);
  if (
    nativeMessages.length === 0 ||
    nativeMessages.length > snapshot.messageDigests.length ||
    nativeMessages.some(
      (message, index) => messageDigest(message) !== snapshot.messageDigests[index],
    )
  ) {
    return undefined;
  }
  return {
    model: snapshot.model,
    sourceMessages: messages,
    context: {
      systemPrompt: snapshot.systemPrompt,
      tools: snapshot.tools,
      messages: nativeMessages,
    },
  };
}
