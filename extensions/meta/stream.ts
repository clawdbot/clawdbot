// Meta plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

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
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model, options }) => {
    if (model.provider !== "meta") {
      return;
    }
    // Responses treats zero as an unset caller cap. Restore the catalog limit
    // without changing provider-selected behavior when the caller omits the field.
    if (options?.maxTokens === 0 && payload.max_output_tokens === undefined) {
      payload.max_output_tokens = model.maxTokens;
    }
    if (!model.reasoning) {
      return;
    }
    ensureMetaResponsesReplayFields(payload);
  });
}

export function wrapMetaProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  if (ctx.provider !== "meta" || (ctx.sourceApi ?? ctx.model?.api) !== "openai-responses") {
    return undefined;
  }
  return createMetaResponsesWrapper(ctx.streamFn);
}
