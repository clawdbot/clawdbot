import type { StreamFn } from "@mariozechner/pi-agent-core";

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
