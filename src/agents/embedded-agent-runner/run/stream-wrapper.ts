/**
 * Wraps stream object events with mutable assistant-message transforms.
 */
import type { MutableAssistantMessageEventStream } from "../../stream-compat.js";
import { createStreamIteratorWrapper } from "../../stream-iterator-wrapper.js";

type EventTransform = (event: Record<string, unknown>) => void | Promise<void>;
const eventTransforms = new WeakMap<
  MutableAssistantMessageEventStream,
  {
    iterator: MutableAssistantMessageEventStream[typeof Symbol.asyncIterator];
    transforms: EventTransform[];
  }
>();

/**
 * Mutates a stream so every object event passes through `onEvent` before the
 * consumer receives it. Used by stream adapters that need to normalize partial
 * and final message snapshots without replacing the stream object.
 */
export function wrapStreamObjectEvents(
  stream: MutableAssistantMessageEventStream,
  onEvent: EventTransform,
): MutableAssistantMessageEventStream {
  const previous = eventTransforms.get(stream);
  // Coalesce only adjacent decorators: an intervening iterator may buffer or
  // replace events, and its position in the normalization pipeline must survive.
  if (previous?.iterator === stream[Symbol.asyncIterator]) {
    previous.transforms.push(onEvent);
    return stream;
  }
  const transforms = [onEvent];
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  const iterator = function () {
    // An already opened iterator keeps the transforms installed when it opened.
    const activeTransforms = transforms.slice();
    return createStreamIteratorWrapper({
      iterator: originalAsyncIterator(),
      next: async (streamIterator) => {
        const result = await streamIterator.next();
        if (!result.done && result.value && typeof result.value === "object") {
          for (const transform of activeTransforms) {
            const pending = transform(result.value as Record<string, unknown>);
            if (pending) {
              await pending;
            }
          }
        }
        return result;
      },
    });
  };
  stream[Symbol.asyncIterator] = iterator;
  eventTransforms.set(stream, { iterator, transforms });
  return stream;
}
