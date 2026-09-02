// Xai plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_GROK_OAUTH_BASE_URL } from "./provider-catalog.js";
import { isXaiProviderId } from "./provider-id.js";

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);
type DynamicFastMode = boolean | (() => boolean | undefined);

function isXaiGrokOAuthProxyModel(model: Parameters<StreamFn>[0]): boolean {
  return (
    isXaiProviderId(model.provider) &&
    model.baseUrl?.trim().replace(/\/+$/u, "") === XAI_GROK_OAUTH_BASE_URL
  );
}

function createXaiGrokOAuthHeadersWrapper(
  baseStreamFn: StreamFn | undefined,
  clientVersion: string | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const normalizedClientVersion = clientVersion?.trim();
  return (model, context, options) => {
    if (!normalizedClientVersion || !isXaiGrokOAuthProxyModel(model)) {
      return underlying(model, context, options);
    }
    const headers = new Headers(options?.headers);
    // The Grok OAuth proxy requires its CLI identity and a concrete catalog model.
    // Keep these proxy-only so ordinary xAI API-key traffic retains its public contract.
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-version", normalizedClientVersion);
    headers.set("x-grok-model-override", model.id);
    return underlying(model, context, {
      ...options,
      headers: Object.fromEntries(headers.entries()),
    });
  };
}

function resolveXaiFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return XAI_FAST_MODEL_IDS.get(modelId.trim());
}

function supportsExplicitImageInput(model: { input?: unknown }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function supportsReasoningControls(model: { compat?: unknown; reasoning?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsReasoningEffort?: unknown })
      : undefined;
  return model.reasoning === true && compat?.supportsReasoningEffort !== false;
}

const XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";

/** xAI-only: request encrypted reasoning for every reasoning-capable model, even when effort is unsupported. */
function ensureXaiResponsesEncryptedReasoningInclude(
  payloadObj: Record<string, unknown>,
  model: { api?: unknown; provider?: unknown; reasoning?: unknown },
): void {
  if (
    !isXaiProviderId(model.provider) ||
    model.api !== "openai-responses" ||
    model.reasoning !== true
  ) {
    return;
  }
  const existing = payloadObj.include;
  const include = filterStringEntries(existing);
  if (!include.includes(XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE)) {
    include.push(XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE);
  }
  payloadObj.include = include;
}

const TOOL_RESULT_IMAGE_REPLAY_TEXT = "Attached image(s) from tool result:";

type ReplayableInputImagePart =
  | {
      type: "input_image";
      source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
    }
  | { type: "input_image"; image_url: string; detail?: string };

type NormalizedFunctionCallOutput = {
  normalizedItem: unknown;
  imageParts: Array<Record<string, unknown>>;
};

function isReplayableInputImagePart(
  part: Record<string, unknown>,
): part is ReplayableInputImagePart {
  if (part.type !== "input_image") {
    return false;
  }
  if (typeof part.image_url === "string") {
    return true;
  }
  if (!part.source || typeof part.source !== "object") {
    return false;
  }
  const source = part.source as {
    type?: unknown;
    url?: unknown;
    media_type?: unknown;
    data?: unknown;
  };
  if (source.type === "url") {
    return typeof source.url === "string";
  }
  return (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  );
}

function describeXaiFunctionOutputMediaPlaceholder(
  parts: Array<Record<string, unknown>>,
): string | undefined {
  let hasImage = false;
  let hasAudio = false;
  let hasOtherMedia = false;

  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    const mimeType =
      typeof part.mimeType === "string"
        ? part.mimeType
        : typeof part.mime_type === "string"
          ? part.mime_type
          : typeof part.mediaType === "string"
            ? part.mediaType
            : typeof part.contentType === "string"
              ? part.contentType
              : "";
    const normalizedMime = mimeType.toLowerCase();
    if (type.includes("image") || normalizedMime.startsWith("image/")) {
      hasImage = true;
    } else if (type.includes("audio") || normalizedMime.startsWith("audio/")) {
      hasAudio = true;
    } else if (type !== "input_text") {
      hasOtherMedia = true;
    }
  }

  if ((hasImage && hasAudio) || hasOtherMedia) {
    return "(see attached media)";
  }
  if (hasAudio) {
    return "(see attached audio)";
  }
  if (hasImage) {
    return "(see attached image)";
  }
  return undefined;
}

function normalizeXaiResponsesFunctionCallOutput(
  item: unknown,
  includeImages: boolean,
): NormalizedFunctionCallOutput {
  if (!item || typeof item !== "object") {
    return { normalizedItem: item, imageParts: [] };
  }

  const itemObj = item as Record<string, unknown>;
  if (itemObj.type !== "function_call_output" || !Array.isArray(itemObj.output)) {
    return { normalizedItem: itemObj, imageParts: [] };
  }

  const outputParts = itemObj.output as Array<Record<string, unknown>>;
  const textOutput = outputParts
    .filter(
      (part): part is { type: "input_text"; text: string } =>
        part.type === "input_text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");

  const imageParts = includeImages
    ? outputParts.filter((part): part is ReplayableInputImagePart =>
        isReplayableInputImagePart(part),
      )
    : [];
  const hadNonTextParts = outputParts.some((part) => part.type !== "input_text");
  const mediaPlaceholder = describeXaiFunctionOutputMediaPlaceholder(outputParts);

  return {
    normalizedItem: {
      ...itemObj,
      output: textOutput || mediaPlaceholder || (hadNonTextParts ? "(see attached media)" : ""),
    },
    imageParts,
  };
}

function normalizeXaiResponsesToolResultPayload(
  payloadObj: Record<string, unknown>,
  model: { api?: unknown; input?: unknown },
): void {
  if (model.api !== "openai-responses" || !Array.isArray(payloadObj.input)) {
    return;
  }

  const includeImages = supportsExplicitImageInput(model);
  const normalizedInput: unknown[] = [];
  const collectedImageParts: Array<Record<string, unknown>> = [];

  for (const item of payloadObj.input) {
    const normalized = normalizeXaiResponsesFunctionCallOutput(item, includeImages);
    normalizedInput.push(normalized.normalizedItem);
    collectedImageParts.push(...normalized.imageParts);
  }

  if (collectedImageParts.length > 0) {
    normalizedInput.push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: TOOL_RESULT_IMAGE_REPLAY_TEXT },
        ...collectedImageParts,
      ],
    });
  }

  payloadObj.input = normalizedInput;
}

function createXaiToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    normalizeXaiResponsesToolResultPayload(payload, model);
    if (!supportsReasoningControls(model)) {
      // Only current flagship Grok models advertise configurable effort.
      delete payload.reasoning;
      delete payload.reasoningEffort;
      delete payload.reasoning_effort;
    }
    // All reasoning xAI models should still request + later replay encrypted_content.
    ensureXaiResponsesEncryptedReasoningInclude(payload, model);
  });
}

function createXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: DynamicFastMode,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const supportsFastAliasTransport =
      model.api === "openai-completions" || model.api === "openai-responses";
    if (
      (typeof fastMode === "function" ? fastMode() : fastMode) !== true ||
      !supportsFastAliasTransport ||
      !isXaiProviderId(model.provider)
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveXaiFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

function resolveXaiFastMode(extraParams: Record<string, unknown> | undefined): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  if (typeof raw === "function") {
    const resolved = (raw as () => unknown)();
    return typeof resolved === "boolean" ? resolved : undefined;
  }
  return typeof raw === "boolean" ? raw : undefined;
}

function hasXaiFastModeParam(extraParams: Record<string, unknown> | undefined): boolean {
  return Boolean(
    extraParams &&
    (Object.hasOwn(extraParams, "fastMode") || Object.hasOwn(extraParams, "fast_mode")),
  );
}

export function wrapXaiProviderStream(
  ctx: ProviderWrapStreamFnContext,
  runtime?: { clientVersion?: string },
): StreamFn | undefined {
  const extraParams = ctx.extraParams;
  const toolStreamEnabled = extraParams?.tool_stream !== false;
  return composeProviderStreamWrappers(
    ctx.streamFn,
    (streamFn) => createXaiGrokOAuthHeadersWrapper(streamFn, runtime?.clientVersion),
    createXaiToolPayloadCompatibilityWrapper,
    hasXaiFastModeParam(extraParams) &&
      ((streamFn) => createXaiFastModeWrapper(streamFn, () => resolveXaiFastMode(extraParams))),
    createPlainTextToolCallCompatWrapper,
    (streamFn) => createToolStreamWrapper(streamFn, toolStreamEnabled),
  );
}
