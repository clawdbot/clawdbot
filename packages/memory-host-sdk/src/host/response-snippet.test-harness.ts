import { type Mock, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

export function createPendingResponse(params: { prefix?: string; status?: number } = {}) {
  const readStarted = createDeferred();
  const cancel: Mock<(reason?: unknown) => void> = vi.fn();
  let prefix = params.prefix;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodyController = controller;
        },
        pull(controller) {
          if (prefix !== undefined) {
            controller.enqueue(new TextEncoder().encode(prefix));
            prefix = undefined;
          } else {
            readStarted.resolve();
          }
        },
        cancel,
      },
      // A pull must mean a reader is waiting, not background prefetch.
      { highWaterMark: 0 },
    ),
    { status: params.status ?? 200 },
  );
  return {
    response,
    readStarted: readStarted.promise,
    cancel,
    dispose: () => bodyController?.error(new Error("response fixture disposed")),
  };
}
