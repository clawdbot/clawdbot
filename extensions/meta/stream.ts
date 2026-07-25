// Meta plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

const META_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";

function ensureMetaResponsesReplayFields(payloadObj: Record<string, unknown>): void {
  const existing = payloadObj.include;
  const include = Array.isArray(existing)
    ? existing.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!include.includes(META_REASONING_ENCRYPTED_CONTENT_INCLUDE)) {
    include.push(META_REASONING_ENCRYPTED_CONTENT_INCLUDE);
  }
  payloadObj.include = include;
  payloadObj.store = false;
}

function createMetaResponsesWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      if (model.provider !== "meta" || model.api !== "openai-responses") {
        return;
      }
      if (!model.reasoning) {
        return;
      }
      ensureMetaResponsesReplayFields(payloadObj);
    });
}

export function wrapMetaProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (ctx.provider !== "meta" || ctx.model?.api !== "openai-responses") {
    return undefined;
  }
  return createMetaResponsesWrapper(ctx.streamFn);
}
