/**
 * Stream hook test helpers for capturing provider thinking config.
 */
import type { StreamFn } from "../../agents/runtime/index.js";

export function createCapturedThinkingConfigStream() {
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn: StreamFn = (model, _context, options) => {
    const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
      string,
      unknown
    >;
    options?.onPayload?.(payload as never, model as never);
    capturedPayload = payload;
    return {} as never;
  };
  return {
    streamFn,
    getCapturedPayload: () => capturedPayload,
  };
}
