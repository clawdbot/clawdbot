import { streamSimple } from "../../llm/stream.js";
import { visitObjectContentBlocks } from "../../shared/message-content-blocks.js";
import type { StreamFn } from "../runtime/index.js";
import type { MutableAssistantMessageEventStream } from "../stream-compat.js";

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

function decodeHtmlEntities(value: string): string {
  const decodeNumericEntity = (raw: string, radix: 10 | 16): string => {
    const codePoint = Number.parseInt(raw, radix);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : `&#${radix === 16 ? "x" : ""}${raw};`;
  };

  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeNumericEntity(hex, 16))
    .replace(/&#(\d+);/gi, (_, dec: string) => decodeNumericEntity(dec, 10));
}

export function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return HTML_ENTITY_RE.test(value) ? decodeHtmlEntities(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeHtmlEntitiesInObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(entry);
    }
    return result;
  }
  return value;
}

function decodeToolCallArgumentsHtmlEntitiesInMessage(message: unknown): void {
  visitObjectContentBlocks(message, (block) => {
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      return;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  });
}

function wrapStreamMessageObjects(
  stream: MutableAssistantMessageEventStream,
  transformMessage: (message: unknown) => void,
): MutableAssistantMessageEventStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    transformMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            transformMessage(event.partial);
            transformMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

export function createHtmlEntityToolCallArgumentDecodingWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamMessageObjects(stream, decodeToolCallArgumentsHtmlEntitiesInMessage),
      );
    }
    return wrapStreamMessageObjects(maybeStream, decodeToolCallArgumentsHtmlEntitiesInMessage);
  };
}
