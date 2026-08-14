import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
  requestOpenAIResponsesCompaction,
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

type ServerEndpointCompactionResult = Awaited<ReturnType<typeof requestOpenAIResponsesCompaction>>;

/** Try provider-owned compaction and persist its replay checkpoint on the session owner. */
export async function attemptServerEndpointCompaction(params: {
  trigger: "budget" | "overflow" | "manual";
  model: Parameters<typeof requestOpenAIResponsesCompaction>[0];
  context: { systemPrompt: string; messages: readonly AgentMessage[] };
  sessionManager: SessionManagerLike;
  requestOptions: Parameters<typeof requestOpenAIResponsesCompaction>[2];
}): Promise<ServerEndpointCompactionResult | undefined> {
  if (
    params.trigger === "overflow" ||
    !resolveOpenAIResponsesCompactEndpointPlan(
      params.model,
      params.requestOptions as Record<string, unknown>,
    ).enabled
  ) {
    return undefined;
  }
  try {
    const messages = params.context.messages.filter(
      (message): message is Message =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    const owner = params.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("Responses compact endpoint requires a persisted assistant owner");
    }
    const compacted = await compactWithSafetyTimeout(
      (signal) =>
        requestOpenAIResponsesCompaction(
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
      replacement.content.length,
      params.model,
      buildOpenAIResponsesReasoningReplayMetadata(params.model, {
        sessionId: params.requestOptions.sessionId,
        authProfileId: params.requestOptions.authProfileId,
      }),
    );
    const rewritten = rewriteTranscriptEntriesInSessionManager({
      sessionManager: params.sessionManager,
      replacements: [{ entryId: owner.id, message: replacement }],
      preserveReplacementCompactionReplay: true,
    });
    if (replacement.providerReplay?.type !== "openai-responses-compaction" || !rewritten.changed) {
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
