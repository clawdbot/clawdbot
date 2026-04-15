import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export type ProviderStreamWrapperFactory =
  | ((streamFn: StreamFn | undefined) => StreamFn | undefined)
  | null
  | undefined
  | false;

export function composeProviderStreamWrappers(
  baseStreamFn: StreamFn | undefined,
  ...wrappers: ProviderStreamWrapperFactory[]
): StreamFn | undefined {
  return wrappers.reduce(
    (streamFn, wrapper) => (wrapper ? wrapper(streamFn) : streamFn),
    baseStreamFn,
  );
}

export function defaultToolStreamExtraParams(
  extraParams?: Record<string, unknown>,
): Record<string, unknown> {
  if (extraParams?.tool_stream !== undefined) {
    return extraParams;
  }
  return {
    ...extraParams,
    tool_stream: true,
  };
}

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
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
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

function wrapStreamDecodeToolCallArgumentHtmlEntities(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeToolCallArgumentsHtmlEntitiesInMessage(message);
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
            decodeToolCallArgumentsHtmlEntitiesInMessage(event.partial);
            decodeToolCallArgumentsHtmlEntitiesInMessage(event.message);
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
        wrapStreamDecodeToolCallArgumentHtmlEntities(stream),
      );
    }
    return wrapStreamDecodeToolCallArgumentHtmlEntities(maybeStream);
  };
}

export {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "../agents/anthropic-payload-policy.js";
export {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../agents/copilot-dynamic-headers.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../agents/pi-embedded-runner/anthropic-cache-control-payload.js";
export {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "../agents/pi-embedded-runner/bedrock-stream-wrappers.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
export {
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
} from "../agents/pi-embedded-runner/zai-stream-wrappers.js";
