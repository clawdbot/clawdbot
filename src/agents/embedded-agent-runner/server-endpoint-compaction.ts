import {
  captureOpenAIResponsesCompaction,
  requestPreparedOpenAIResponsesCompaction,
  resolveOpenAIResponsesCompactEndpointPlan,
} from "@openclaw/ai/transports";
import type { Message } from "@openclaw/llm-core";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AgentMessage } from "../runtime/index.js";
import { compactWithSafetyTimeout } from "./compaction-safety-timeout.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

type SessionManagerLike = Parameters<
  typeof rewriteTranscriptEntriesInSessionManager
>[0]["sessionManager"];

type ServerEndpointCompactionResult = Awaited<
  ReturnType<typeof requestPreparedOpenAIResponsesCompaction>
>;

/** Try provider-owned compaction and persist its replay checkpoint on the session owner. */
export async function attemptServerEndpointCompaction(params: {
  trigger: "budget" | "overflow" | "manual";
  streamFn: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[0];
  model: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[1];
  context: { systemPrompt: string; messages: readonly AgentMessage[] };
  sessionManager: SessionManagerLike;
  extraParams: Record<string, unknown>;
  requestOptions: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[3];
  customInstructions?: string;
}): Promise<ServerEndpointCompactionResult | undefined> {
  if (
    params.trigger === "overflow" ||
    params.customInstructions?.trim() ||
    !resolveOpenAIResponsesCompactEndpointPlan(params.model, params.extraParams).enabled
  ) {
    return undefined;
  }
  try {
    const messages = params.context.messages.filter(
      (message): message is Message =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    if (messages.at(-1)?.role !== "assistant") {
      return undefined;
    }
    const owner = params.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("Responses compact endpoint requires a persisted assistant owner");
    }
    const compacted = await compactWithSafetyTimeout(
      (signal) =>
        requestPreparedOpenAIResponsesCompaction(
          params.streamFn,
          params.model,
          { systemPrompt: params.context.systemPrompt, messages },
          { ...params.requestOptions, signal },
        ),
      params.requestOptions.timeoutMs,
      params.requestOptions.signal ? { abortSignal: params.requestOptions.signal } : undefined,
    );
    const replacement = structuredClone(owner.message);
    captureOpenAIResponsesCompaction(
      replacement,
      compacted.item,
      compacted.historyMode === "retained-users" ? "retained-users" : replacement.content.length,
      compacted.model,
      compacted.replayMetadata,
    );
    const rewritten = rewriteTranscriptEntriesInSessionManager({
      sessionManager: params.sessionManager,
      replacements: [{ entryId: owner.id, message: replacement }],
      preserveReplacementCompactionReplay: true,
    });
    if (
      replacement.providerReplay?.data !== compacted.item.encrypted_content ||
      !rewritten.changed
    ) {
      throw new Error(
        `Responses compact endpoint checkpoint was not persisted: ${rewritten.reason}`,
      );
    }
    return compacted;
  } catch (err) {
    log.debug(
      `Responses compact endpoint failed; falling back to client compaction: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}
