import { createHash } from "node:crypto";
import type { AgentMessage, CompactionForegroundContext } from "@openclaw/agent-core";
import type { Context, Model } from "../llm/types.js";
import { convertToLlm } from "./sessions/messages.js";
import { sanitizeToolCallIdsForCloudCodeAssist, type ToolCallIdMode } from "./tool-call-id.js";

type PrefixBoundaryOptions = {
  timezone?: string;
  includeTimestamp?: boolean;
  appendOnlyRuntimeContext?: boolean;
  toolCallIds?: {
    mode: ToolCallIdMode;
    preserveNativeAnthropicToolUseIds: boolean;
    duplicateToolCallIdStyle?: "openai";
    preserveReplaySafeThinkingToolCallIds: boolean;
    allowedToolNames: string[];
  };
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
  if (
    Buffer.byteLength(JSON.stringify([context.systemPrompt, tools, boundaryOptions])) >
    256 * 1024
  ) {
    return undefined;
  }
  return {
    model: { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl },
    systemPrompt: context.systemPrompt,
    tools: tools && structuredClone(tools),
    messageDigests: context.messages.map(messageDigest),
    boundaryOptions: boundaryOptions && structuredClone(boundaryOptions),
  };
}

/** Only an unchanged leading history range can reuse the foreground cache. */
export async function resolveCompactionPrefix(
  snapshot: CompactionPrefixSnapshot | undefined,
  messages: AgentMessage[],
  onIneligible?: (reason: string) => void,
): Promise<CompactionForegroundContext | undefined> {
  const reject = (reason: string) => {
    onIneligible?.(reason);
    return undefined;
  };
  if (!snapshot) {
    return reject("no-snapshot");
  }
  if (messages.length === 0) {
    return reject("empty-history");
  }
  // Session construction also consumes this module; load its replay projector
  // only once the compaction owner is running, after session initialization.
  const normalize = snapshot.boundaryOptions
    ? (await import("./embedded-agent-runner/run/attempt-llm-boundary.js"))
        .normalizeMessagesForLlmBoundary
    : (source: AgentMessage[]) => source;
  const project = (source: AgentMessage[]) =>
    convertToLlm(normalize(source, snapshot.boundaryOptions));
  const mismatchReason = (native: Context["messages"]): string | undefined => {
    if (native.length === 0) {
      return "empty-projection";
    }
    if (native.length > snapshot.messageDigests.length) {
      return `history-longer:messages=${native.length}:digests=${snapshot.messageDigests.length}`;
    }
    const mismatchIndex = native.findIndex(
      (message, index) => messageDigest(message) !== snapshot.messageDigests[index],
    );
    return mismatchIndex < 0
      ? undefined
      : `digest-mismatch:index=${mismatchIndex}:role=${native[mismatchIndex]?.role}`;
  };
  let nativeMessages = project(messages);
  let reason = mismatchReason(nativeMessages);
  const toolCallIds = snapshot.boundaryOptions?.toolCallIds;
  if (reason && toolCallIds) {
    // Earlier turns pass through ID repair at foreground replay; same-attempt
    // tool turns may still be raw. Admit either only by the dispatched digests.
    nativeMessages = project(
      sanitizeToolCallIdsForCloudCodeAssist(messages, toolCallIds.mode, toolCallIds),
    );
    reason = mismatchReason(nativeMessages);
  }
  if (reason) {
    return reject(reason);
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
