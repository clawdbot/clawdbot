import type { Model } from "@openclaw/llm-core";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import type { OpenAIResponsesCompactionRejection } from "../provider-options.js";
import type { createOpenAIResponsesClient } from "./openai-responses-client.js";
import {
  DEFAULT_AZURE_OPENAI_API_VERSION,
  type OpenAIResponsesRequestParams,
} from "./openai-responses-contracts.js";
import type { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
import { stripEncryptedReasoningContentFields } from "./openai-responses-replay-messages-internal.js";
import { log } from "./openai-transport-shared.js";

type ResponsesClientLike = ReturnType<typeof createOpenAIResponsesClient>;

export function isInvalidEncryptedContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; status?: unknown };
  if (record.code === "invalid_encrypted_content" || record.code === "thinking_signature_invalid") {
    return true;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return (
    message.includes("invalid_encrypted_content") ||
    message.includes("thinking_signature_invalid") ||
    // xAI reports this exact prose contract without an error code.
    (record.status === 400 &&
      message.toLowerCase().includes("could not decrypt the provided encrypted_content"))
  );
}

function isOrphanedFunctionCallOutputError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  // Server rejects a function_call_output whose function_call lives inside the
  // encrypted compaction blob. Match by substring like the sibling classifiers:
  // wrapped transport errors prefix the raw body ("400 ...", "HTTP 400: {json}").
  return /No tool call found for function call output with call_id [A-Za-z0-9_-]+/.test(message);
}

type ResponsesEncryptedContentRequest = { input?: ResponseInput };

type ResponsesEncryptedContentAttemptKind =
  | "initial"
  | "reasoning-stripped"
  | "compaction-stripped"
  | "continuation-rejected";

export type ResponsesEncryptedContentAttempt<TRequest extends ResponsesEncryptedContentRequest> = {
  kind: ResponsesEncryptedContentAttemptKind;
  request: TRequest;
  rejectedCompaction?: OpenAIResponsesCompactionRejection;
};

export function commitResponsesEncryptedContentAttempt(
  attempt: ResponsesEncryptedContentAttempt<ResponsesEncryptedContentRequest>,
  commit: (checkpoint: OpenAIResponsesCompactionRejection | undefined) => void,
): void {
  if (attempt.kind === "compaction-stripped") {
    commit(attempt.rejectedCompaction);
  }
}

function stripResponsesRequestEncryptedReasoning<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  const stripped = stripEncryptedReasoningContentFields(request.input);
  if (!stripped.changed) {
    return request;
  }
  return {
    ...request,
    input: stripped.value as ResponseInput,
  };
}

function stripResponsesRequestCompaction<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  if (!Array.isArray(request.input)) {
    return request;
  }
  const input = request.input.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "compaction"
      ),
  );
  return input.length === request.input.length ? request : { ...request, input };
}

function readOpenAIResponsesCompactionRejection(
  request: ResponsesEncryptedContentRequest,
): OpenAIResponsesCompactionRejection | undefined {
  if (!Array.isArray(request.input)) {
    return undefined;
  }
  const item = request.input.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as { type?: unknown }).type === "compaction" &&
      typeof (candidate as { encrypted_content?: unknown }).encrypted_content === "string",
  ) as { encrypted_content: string; id?: unknown } | undefined;
  return item
    ? { data: item.encrypted_content, ...(typeof item.id === "string" ? { id: item.id } : {}) }
    : undefined;
}

export async function resolveNextResponsesEncryptedContentAttempt<
  TRequest extends ResponsesEncryptedContentRequest,
>(
  attempt: ResponsesEncryptedContentAttempt<TRequest>,
  error: unknown,
  options?: { buildFullHistoryRequest?: () => TRequest | Promise<TRequest> },
): Promise<ResponsesEncryptedContentAttempt<TRequest> | undefined> {
  const orphanedFunctionOutput = isOrphanedFunctionCallOutputError(error);
  if (
    (!isInvalidEncryptedContentError(error) && !orphanedFunctionOutput) ||
    attempt.kind === "compaction-stripped"
  ) {
    return undefined;
  }
  if (
    !orphanedFunctionOutput &&
    (attempt.kind === "initial" || attempt.kind === "continuation-rejected")
  ) {
    const reasoningStripped = stripResponsesRequestEncryptedReasoning(attempt.request);
    if (reasoningStripped !== attempt.request) {
      return { kind: "reasoning-stripped", request: reasoningStripped };
    }
  }
  const locallyStripped = stripResponsesRequestCompaction(attempt.request);
  if (locallyStripped === attempt.request) {
    return undefined;
  }
  // Filtering the already-pruned checkpoint request would leave a context-blind
  // suffix. Rebuild full history lazily, then preserve any earlier reasoning strip.
  let compactionStripped = options?.buildFullHistoryRequest
    ? await options.buildFullHistoryRequest()
    : locallyStripped;
  compactionStripped = stripResponsesRequestCompaction(compactionStripped);
  if (attempt.kind === "reasoning-stripped") {
    compactionStripped = stripResponsesRequestEncryptedReasoning(compactionStripped);
  }
  return {
    kind: "compaction-stripped",
    request: compactionStripped,
    rejectedCompaction: readOpenAIResponsesCompactionRejection(attempt.request),
  };
}

export async function createResponsesStreamWithEncryptedContentRetry(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: unknown;
  model: Model;
  observePrompt?: NonNullable<ReturnType<typeof createResponsesPromptEgressObserver>>;
  initialAttemptKind?: ResponsesEncryptedContentAttemptKind;
  initialRejectedCompaction?: OpenAIResponsesCompactionRejection;
  onCompactionRejected?: (checkpoint: OpenAIResponsesCompactionRejection) => void;
  buildFullHistoryRequest?: () =>
    | OpenAIResponsesRequestParams
    | Promise<OpenAIResponsesRequestParams>;
}): Promise<{
  stream: AsyncIterable<unknown>;
  response: Response;
  attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>;
}> {
  const sendAttempt = async (
    attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>,
  ) => {
    const { data, response } = await params.client.responses
      .create(attempt.request as never, params.requestOptions as never)
      .withResponse();
    commitResponsesEncryptedContentAttempt(attempt, (checkpoint) => {
      if (checkpoint) {
        params.onCompactionRejected?.(checkpoint);
      }
    });
    return { stream: data as unknown as AsyncIterable<unknown>, response, attempt };
  };

  let attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams> = {
    kind: params.initialAttemptKind ?? "initial",
    request: params.request,
    ...(params.initialRejectedCompaction
      ? { rejectedCompaction: params.initialRejectedCompaction }
      : {}),
  };
  while (true) {
    params.observePrompt?.(attempt.request, {
      egress: "responses-sdk",
      payloadVariant: attempt.kind,
    });
    try {
      return await sendAttempt(attempt);
    } catch (error) {
      let nextAttempt = await resolveNextResponsesEncryptedContentAttempt(attempt, error, {
        buildFullHistoryRequest: params.buildFullHistoryRequest,
      });
      if (
        !nextAttempt &&
        attempt.request.previous_response_id &&
        error &&
        typeof error === "object" &&
        typeof (error as { status?: unknown }).status === "number" &&
        (error as { code?: unknown }).code === "previous_response_not_found"
      ) {
        const request = {
          ...(params.buildFullHistoryRequest
            ? await params.buildFullHistoryRequest()
            : attempt.request),
        };
        delete request.previous_response_id;
        nextAttempt = { kind: "continuation-rejected", request };
      }
      if (!nextAttempt) {
        throw error;
      }
      const retryDescription =
        nextAttempt.kind === "reasoning-stripped"
          ? "without encrypted reasoning content"
          : nextAttempt.kind === "compaction-stripped"
            ? "without encrypted compaction content"
            : "full history after rejected previous_response_id";
      log.warn(
        `[responses] retrying ${retryDescription} provider=${params.model.provider} ` +
          `api=${params.model.api} model=${params.model.id}`,
      );
      attempt = nextAttempt;
    }
  }
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

export {
  buildResponsesInputMessage,
  convertProviderResponsesMessages,
  convertResponsesMessages,
  createOpenAIResponsesAssistantOutput,
  encodeTextSignatureV1,
} from "./openai-responses-replay-messages-internal.js";
