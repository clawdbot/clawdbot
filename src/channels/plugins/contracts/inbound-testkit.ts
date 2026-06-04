import { vi } from "vitest";

// Test helper for inbound channel contract suites. It replaces dispatch with a
// capture mock while preserving the rest of the actual module surface.
export function buildDispatchInboundCaptureMock<T extends Record<string, unknown>>(
  actual: T,
  setCtx: (ctx: unknown) => void,
) {
  const dispatchInboundMessage = vi.fn(async (params: { ctx: unknown }) => {
    setCtx(params.ctx);
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });

  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
}
