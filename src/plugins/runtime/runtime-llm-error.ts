import type { LlmCompleteErrorCode } from "./types-core.js";

export function createLlmCompleteError(
  code: LlmCompleteErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: LlmCompleteErrorCode } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: "LlmCompleteError",
    code,
  });
}
