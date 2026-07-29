/**
 * Wraps stream object events with mutable assistant-message transforms.
 */
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";

/**
 * Mutates a stream so every object event passes through `onEvent` before the
 * consumer receives it. Used by stream adapters that need to normalize partial
 * and final message snapshots without replacing the stream object.
 */
export function wrapStreamObjectEvents(
  stream: MutableAssistantMessageEventStream,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): MutableAssistantMessageEventStream {
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return createStreamIteratorWrapper({
        iterator,
        next: async (streamIterator) => {
          const result = await streamIterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            await onEvent(result.value as Record<string, unknown>);
          }
          return result;
        },
      });
    };
  return stream;
}
