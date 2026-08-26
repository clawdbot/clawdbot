import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { resolveProviderContext, streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingKeep,
  resolveMoonshotThinkingType,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMoonshotAlwaysThinkingModelId,
  isMoonshotK3NativeVideoRoute,
} from "./provider-policy-api.js";

const VIDEO_PREFIX = "data:video/mp4;base64,";
const VIDEO_OMISSION = "(video omitted: untrusted or unsupported Moonshot video)";
const MOONSHOT_REQUEST_BYTES_EXCLUSIVE = 100_000_000;

function forEachUserContentPart(payload: unknown, visit: (part: Record<string, unknown>) => void) {
  const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (isRecord(part)) {
        visit(part);
      }
    }
  }
}

function partUrl(part: Record<string, unknown>, field: "image_url" | "video_url") {
  const url = isRecord(part[field]) ? part[field].url : undefined;
  return typeof url === "string" ? url : undefined;
}

function replacePart(part: Record<string, unknown>, text: string) {
  Object.keys(part).forEach((key) => Reflect.deleteProperty(part, key));
  Object.assign(part, { type: "text", text });
}

function finalizePayload(
  result: unknown,
  payload: Record<string, unknown>,
  requestBytesExclusive: number,
) {
  const admitted: Record<string, unknown>[] = [];
  forEachUserContentPart(payload, (part) => {
    const videoUrl = partUrl(part, "video_url");
    const imageUrl = partUrl(part, "image_url");
    if (part.type === "video_url" && videoUrl?.startsWith(VIDEO_PREFIX)) {
      admitted.push(part);
    } else if (part.type === "video_url" || imageUrl?.startsWith("data:video/")) {
      replacePart(part, VIDEO_OMISSION);
    }
  });
  const isOversized = () =>
    Buffer.byteLength(JSON.stringify(payload), "utf8") >= requestBytesExclusive;
  while (admitted.length > 0 && isOversized()) {
    replacePart(admitted.pop()!, "(video omitted: Moonshot request size limit)");
  }
  if (isOversized()) {
    throw new Error(`Moonshot request body must be smaller than ${requestBytesExclusive} bytes`);
  }
  return result;
}

export function wrapMoonshotStream(
  ctx: ProviderWrapStreamFnContext,
  simple = false,
  requestBytesExclusive = MOONSHOT_REQUEST_BYTES_EXCLUSIVE,
): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  if (simple && !isMoonshotAlwaysThinkingModelId(ctx.modelId)) {
    return underlying;
  }
  const withVideoContext: StreamFn = (model, context, options) =>
    isMoonshotK3NativeVideoRoute({ ...model, modelId: model.id })
      ? resolveProviderContext(context, options as never).then((providerContext) =>
          underlying(model, providerContext as never, options),
        )
      : underlying(model, context, options);
  return createMoonshotThinkingWrapper(
    withVideoContext,
    resolveMoonshotThinkingType({
      configuredThinking: ctx.extraParams?.thinking,
      thinkingLevel: ctx.thinkingLevel,
    }),
    resolveMoonshotThinkingKeep({ configuredThinking: ctx.extraParams?.thinking }),
    (result, payload) => finalizePayload(result, payload, requestBytesExclusive),
  );
}
