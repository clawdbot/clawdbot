import { vi } from "vitest";

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
