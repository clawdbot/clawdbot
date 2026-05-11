import { streamSimple } from "@earendil-works/pi-ai";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";

type SimpleStream = ReturnType<typeof streamSimple>;

export function wrapStreamObjectEvents(
  stream: SimpleStream,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): SimpleStream {
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
