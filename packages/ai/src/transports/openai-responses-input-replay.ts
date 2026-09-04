import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { sha256Hex } from "./transport-utils.js";

export type ResponsesInputReplay = { afterResponseId: string; before: string[]; after: string[] };

export function recordResponsesInputReplay(
  message: AssistantMessage,
  replay?: ResponsesInputReplay,
) {
  if (replay) {
    Object.assign(message, { openclawResponsesInputReplay: replay });
  }
}

function readResponsesInputReplay(message: AssistantMessage): ResponsesInputReplay | undefined {
  const replay =
    "openclawResponsesInputReplay" in message ? message.openclawResponsesInputReplay : undefined;
  if (
    isRecord(replay) &&
    typeof replay.afterResponseId === "string" &&
    Array.isArray(replay.before) &&
    replay.before.every((item) => typeof item === "string") &&
    Array.isArray(replay.after) &&
    replay.after.every((item) => typeof item === "string")
  ) {
    return { afterResponseId: replay.afterResponseId, before: replay.before, after: replay.after };
  }
  return undefined;
}

export function responsesInputFingerprint(item: unknown): string {
  // The call owns result placement even when payload hooks rewrite its body.
  // Matching result text would lose deferred ordering on saved-history replay.
  if (
    isRecord(item) &&
    (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
    typeof item.call_id === "string"
  ) {
    return sha256Hex(stableStringify({ type: item.type, call_id: item.call_id }));
  }
  return sha256Hex(stableStringify(item));
}

/** Reconstruct delivery order without rewriting durable local completion events. */
export function createResponsesInputReplay(model: Model) {
  const starts = new Map<string, ResponseInput[number]>();
  const ends = new Map<string, ResponseInput[number]>();
  const fingerprints = new Map<ResponseInput[number], string>();
  const fingerprint = (item: ResponseInput[number]) => {
    const value = fingerprints.get(item) ?? responsesInputFingerprint(item);
    fingerprints.set(item, value);
    return value;
  };
  return (input: ResponseInput, output: ResponseInput, message: AssistantMessage) => {
    const key = message.turnId || message.responseId;
    const start = (key ? starts.get(key) : undefined) ?? output[0];
    if (key && start) {
      starts.set(key, start);
    }
    input.push(...output);
    let end = input.at(-1);
    const replay = readResponsesInputReplay(message);
    const parent = replay ? ends.get(replay.afterResponseId) : undefined;
    if (
      replay &&
      parent &&
      message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id
    ) {
      const take = (keys: string[]) => {
        const moved: ResponseInput = [];
        // Match the most recent occurrence within this parent's suffix. Identical
        // older user inputs must not be moved when history was edited or compacted.
        for (const inputKey of keys.toReversed()) {
          const boundary = input.indexOf(parent);
          const index = input.findLastIndex(
            (item, position) => position > boundary && fingerprint(item) === inputKey,
          );
          if (index > boundary) {
            moved.unshift(...input.splice(index, 1));
          }
        }
        return moved;
      };
      const before = take(replay.before);
      const after = take(replay.after);
      input.splice(start ? input.indexOf(start) : input.length, 0, ...before);
      end = input.at(-1);
      input.push(...after);
    }
    if (message.responseId && end) {
      // Deferred inputs are not part of this response's prefix.
      ends.set(message.responseId, end);
    }
  };
}
