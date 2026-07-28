import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import {
  extractFunctionCallOutputCallId,
  functionCallOutputIsStructuredError,
  isResponsesToolCallOutput,
  parseCanonicalCodeModeCall,
  parseFunctionCallArguments,
  parseFunctionCallOutputObject,
} from "./mock-openai-input.js";

function readCompletedCodeModeValue(
  input: ResponsesInputItem[],
  execCallIndex: number,
  execOutput: ResponsesInputItem,
): Record<string, unknown> | null {
  const state = parseFunctionCallOutputObject(execOutput);
  if (state?.status === "completed") {
    return state.value && typeof state.value === "object" && !Array.isArray(state.value)
      ? (state.value as Record<string, unknown>)
      : null;
  }
  const runId = state?.status === "waiting" && typeof state.runId === "string" ? state.runId : "";
  if (!runId) {
    return null;
  }
  for (const [waitOffset, candidate] of input.slice(execCallIndex + 1).entries()) {
    if (
      candidate.type !== "function_call" ||
      candidate.name !== "wait" ||
      typeof candidate.call_id !== "string" ||
      parseFunctionCallArguments(candidate)?.runId !== runId
    ) {
      continue;
    }
    const waitOutput = input
      .slice(execCallIndex + waitOffset + 2)
      .find(
        (result) =>
          isResponsesToolCallOutput(result) &&
          extractFunctionCallOutputCallId(result) === candidate.call_id,
      );
    if (!waitOutput || functionCallOutputIsStructuredError(waitOutput)) {
      continue;
    }
    const completed = parseFunctionCallOutputObject(waitOutput);
    if (
      completed?.status === "completed" &&
      completed.value &&
      typeof completed.value === "object" &&
      !Array.isArray(completed.value)
    ) {
      return completed.value as Record<string, unknown>;
    }
  }
  return null;
}

function isAcceptedSessionsSpawnResult(value: Record<string, unknown> | null) {
  if (value?.status !== "accepted" && value?.status !== "completed") {
    return false;
  }
  return [value.childSessionKey, value.childSessionId].some(
    (identity) => typeof identity === "string" && identity.trim().length > 0,
  );
}

export function hasSuccessfulSessionsSpawnToolResult(
  input: ResponsesInputItem[],
  expectedLabel: string,
) {
  for (const [callIndex, item] of input.entries()) {
    if (item.type !== "function_call" || typeof item.call_id !== "string" || !item.call_id.trim()) {
      continue;
    }
    const args = parseFunctionCallArguments(item);
    const codeModeCall = item.name === "exec" ? parseCanonicalCodeModeCall(item) : undefined;
    const matchesSpawn =
      (item.name === "sessions_spawn" && args?.label === expectedLabel) ||
      (codeModeCall?.toolId === "openclaw:core:sessions_spawn" &&
        codeModeCall.args.label === expectedLabel &&
        codeModeCall.args.mode === "run");
    if (!matchesSpawn) {
      continue;
    }
    const matchingOutput = input
      .slice(callIndex + 1)
      .find(
        (candidate) =>
          isResponsesToolCallOutput(candidate) &&
          extractFunctionCallOutputCallId(candidate) === item.call_id,
      );
    if (!matchingOutput || functionCallOutputIsStructuredError(matchingOutput)) {
      continue;
    }
    const result =
      item.name === "sessions_spawn"
        ? parseFunctionCallOutputObject(matchingOutput)
        : readCompletedCodeModeValue(input, callIndex, matchingOutput);
    if (isAcceptedSessionsSpawnResult(result)) {
      return true;
    }
  }
  return false;
}
