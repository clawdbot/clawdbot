import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isOpenAIResponsesReplayContext } from "./openai-responses-compaction-replay.js";
import {
  responsesContinuationPrefixFingerprint,
  responsesContinuationRequestFingerprint,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import {
  isConfigurationUpdate,
  replayResponsesReasoningUpdates,
  supportsResponsesReasoningUpdate,
} from "./openai-responses-reasoning-update.js";
import {
  buildProviderReplayContext,
  providerReplayContextMatches,
} from "./provider-replay-context.js";

type ReplayIdentity = { sessionId?: string; authProfileId?: string };

function inputReplay(message: AssistantMessage) {
  const value =
    "openclawResponsesInputReplay" in message ? message.openclawResponsesInputReplay : undefined;
  return isRecord(value) ? value : undefined;
}

/** Save only admitted settings and hashes, never another copy of the conversation. */
export function recordResponsesReasoningState(
  message: AssistantMessage,
  model: Model,
  identity: ReplayIdentity | undefined,
  request: ResponsesContinuationRequest,
  output: readonly unknown[],
): void {
  if (
    !supportsResponsesReasoningUpdate(request) ||
    !isRecord(request.reasoning) ||
    !request.input ||
    request.previous_response_id ||
    message.providerReplay ||
    output.some((item) => isRecord(item) && item.type === "compaction")
  ) {
    return;
  }
  const reasoning = {
    ...buildProviderReplayContext(model, identity),
    effort: request.reasoning.effort,
    controls: request.input.flatMap((item, index) =>
      isConfigurationUpdate(item) ? [{ index, item }] : [],
    ),
    inputLength: request.input.length,
    outputLength: output.length,
    prefixHash: responsesContinuationPrefixFingerprint(request.input, output),
    requestHash: responsesContinuationRequestFingerprint(request),
  };
  Object.assign(message, { openclawResponsesInputReplay: { ...inputReplay(message), reasoning } });
}

/** A cold transport can replay controls, but cannot resurrect a server response handle. */
export function restoreResponsesReasoningState(
  context: Context,
  model: Model,
  identity: ReplayIdentity | undefined,
  request: ResponsesContinuationRequest,
): ResponsesContinuationRequest {
  const latest = context.messages.findLast((message) => message.role === "assistant");
  const state = latest ? inputReplay(latest)?.reasoning : undefined;
  if (!isRecord(state)) {
    return request;
  }
  const { effort, inputLength, outputLength, controls, prefixHash, requestHash } = state;
  if (
    !isOpenAIResponsesReplayContext(state) ||
    !providerReplayContextMatches(state, buildProviderReplayContext(model, identity)) ||
    latest?.providerReplay ||
    !supportsResponsesReasoningUpdate(request) ||
    !isRecord(request.reasoning) ||
    !request.input ||
    request.previous_response_id ||
    request.input.some(isConfigurationUpdate) ||
    typeof effort !== "string" ||
    typeof inputLength !== "number" ||
    !Number.isSafeInteger(inputLength) ||
    inputLength < 0 ||
    typeof outputLength !== "number" ||
    !Number.isSafeInteger(outputLength) ||
    outputLength < 0 ||
    !Array.isArray(controls) ||
    controls.length > inputLength ||
    inputLength + outputLength > request.input.length + controls.length
  ) {
    return request;
  }
  const previousInput = request.input.slice(0, inputLength - controls.length);
  let lastIndex = -1;
  for (const control of controls) {
    if (
      !isRecord(control) ||
      typeof control.index !== "number" ||
      !Number.isSafeInteger(control.index) ||
      control.index <= lastIndex ||
      control.index > previousInput.length ||
      !isConfigurationUpdate(control.item)
    ) {
      return request;
    }
    previousInput.splice(control.index, 0, control.item);
    lastIndex = control.index;
  }
  const previous = {
    ...request,
    reasoning: { ...request.reasoning, effort },
    input: previousInput,
  };
  if (responsesContinuationRequestFingerprint(previous) !== requestHash) {
    return request;
  }
  const prepared = replayResponsesReasoningUpdates(previous, request, outputLength);
  if (
    responsesContinuationPrefixFingerprint(
      (prepared.input ?? []).slice(0, inputLength + outputLength),
    ) !== prefixHash
  ) {
    return request;
  }
  return prepared;
}
