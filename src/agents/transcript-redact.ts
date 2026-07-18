/**
 * Agent transcript redaction helpers.
 *
 * Applies logging redaction rules to persisted messages while preserving unchanged object identity.
 */
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveFieldValue,
  redactSensitiveText,
} from "../logging/redact.js";
import type { ProviderEndpointClass } from "./provider-attribution.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import type { AgentMessage } from "./runtime/index.js";

function resolveTranscriptRedactPatterns(patterns?: string[]) {
  return patterns && patterns.length > 0 ? [...patterns, ...getDefaultRedactPatterns()] : undefined;
}

function redactTranscriptOptions(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const mode = cfg?.logging?.redactSensitive ?? configuredLogging?.redactSensitive;
  const patterns = resolveTranscriptRedactPatterns(
    cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns,
  );
  if (mode === undefined && patterns === undefined) {
    return undefined;
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(patterns !== undefined ? { patterns } : {}),
  };
}

function isTranscriptRedactionDisabled(cfg?: OpenClawConfig): boolean {
  return (cfg?.logging?.redactSensitive ?? readLoggingConfig()?.redactSensitive) === "off";
}

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveFieldValue(key, value, redactTranscriptOptions(cfg));
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === "string" && /^image\//iu.test(value.trim());
}

function normalizeImageMimeType(value: unknown): string | undefined {
  return isImageMimeType(value) ? value.trim().toLowerCase() : undefined;
}

function imageMimeTypeForRecord(value: Record<string, unknown>): string | undefined {
  return (
    normalizeImageMimeType(value.mimeType) ??
    normalizeImageMimeType(value.mediaType) ??
    normalizeImageMimeType(value.media_type)
  );
}

function imageMimeTypeFieldsForRecord(value: Record<string, unknown>): string[] {
  return ["mimeType", "mediaType", "media_type"].filter((key) => isImageMimeType(value[key]));
}

function sanitizeOpaqueImageBase64(
  base64: string,
  mimeType: string | undefined,
): { mimeType: string; base64: string } | undefined {
  return mimeType ? sanitizeInlineImageBase64({ mimeType, base64 }) : undefined;
}

function isValidOpaqueImageBase64(base64: string, mimeType: string | undefined): boolean {
  return sanitizeOpaqueImageBase64(base64, mimeType) !== undefined;
}

function isTranscriptImageContentBlock(value: Record<string, unknown>): boolean {
  return (
    value.type === "image" &&
    typeof value.data === "string" &&
    isValidOpaqueImageBase64(value.data, imageMimeTypeForRecord(value))
  );
}

function isImageBase64SourceBlock(value: Record<string, unknown>): boolean {
  return (
    value.type === "base64" &&
    typeof value.data === "string" &&
    isValidOpaqueImageBase64(value.data, imageMimeTypeForRecord(value))
  );
}

function sanitizeImageRecord(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const isImageBlock = source.type === "image";
  const isBase64SourceBlock = source.type === "base64";
  if ((!isImageBlock && !isBase64SourceBlock) || typeof source.data !== "string") {
    return undefined;
  }
  const mimeTypeFields = imageMimeTypeFieldsForRecord(source);
  if (mimeTypeFields.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeOpaqueImageBase64(source.data, imageMimeTypeForRecord(source));
  if (!sanitized) {
    return undefined;
  }
  const hasCanonicalMimeTypes = mimeTypeFields.every((key) => source[key] === sanitized.mimeType);
  if (source.data === sanitized.base64 && hasCanonicalMimeTypes) {
    return source;
  }
  const next: Record<string, unknown> = { ...source, data: sanitized.base64 };
  for (const field of mimeTypeFields) {
    next[field] = sanitized.mimeType;
  }
  return next;
}

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, "data:".length).toLowerCase() === "data:";
}

function sanitizeImageDataUrlField(
  source: Record<string, unknown>,
  key: string,
  value: string,
): string | undefined {
  if (!startsWithDataUrl(value)) {
    return undefined;
  }
  const isImageDataUrlField =
    (source.type === "input_image" && key === "image_url") ||
    ((source.type === "image" || source.type === "image_url") && key === "url") ||
    (source.type === "image" && (key === "source" || key === "data"));
  return isImageDataUrlField ? sanitizeInlineImageDataUrlForStorage(value) : undefined;
}

function shouldPreserveOpaqueImagePayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  preserveImageDataUrlFields: boolean,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  if (
    key === "data" &&
    (isTranscriptImageContentBlock(source) || isImageBase64SourceBlock(source))
  ) {
    return true;
  }
  if (preserveImageDataUrlFields && key === "url") {
    return startsWithDataUrl(item) && sanitizeInlineImageDataUrlForStorage(item) !== undefined;
  }
  return sanitizeImageDataUrlField(source, key, item) !== undefined;
}

function shouldPreserveNestedImageDataUrlFields(
  source: Record<string, unknown>,
  key: string,
): boolean {
  return (
    key === "image_url" &&
    (source.type === "image_url" || source.type === "input_image" || source.type === "image")
  );
}

type TranscriptValueLocation =
  | "root"
  | "assistant-content-array"
  | "assistant-content-block"
  | "nested";

type TranscriptAssistantRoute = {
  api?: string;
  endpointClass?: ProviderEndpointClass;
  model?: string;
  provider?: string;
};

const OPENAI_RESPONSES_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-chatgpt-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);
const GOOGLE_REASONING_APIS = new Set([
  "google-generative-ai",
  "google-vertex",
  "google-gemini-cli",
  "openclaw-google-generative-ai-transport",
]);
const ANTHROPIC_REASONING_APIS = new Set([
  "anthropic-messages",
  "bedrock-converse-stream",
  "openclaw-anthropic-messages-transport",
]);
const OPENAI_COMPLETIONS_APIS = new Set([
  "openai-completions",
  "openclaw-openai-completions-transport",
]);
const OPAQUE_REPLAY_TOKEN_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const GOOGLE_THOUGHT_SIGNATURE_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OPENAI_REPLAY_CONTEXT_HASH_RE = /^[a-f0-9]{16}$/;

function isOpenAIResponsesRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && OPENAI_RESPONSES_APIS.has(route.api);
}

function isGoogleReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && GOOGLE_REASONING_APIS.has(route.api);
}

function isAnthropicReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && ANTHROPIC_REASONING_APIS.has(route.api);
}

function isOpenAICompletionsRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && OPENAI_COMPLETIONS_APIS.has(route.api);
}

function isGoogleOpenAICompletionsRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    isOpenAICompletionsRoute(route) &&
    (route?.provider === "google" ||
      route?.endpointClass === "google-generative-ai" ||
      route?.endpointClass === "google-vertex")
  );
}

function isCustomProviderRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    Boolean(route?.api && route.model && route.provider) &&
    route?.api !== "mistral-conversations" &&
    !isOpenAIResponsesRoute(route) &&
    !isGoogleReasoningRoute(route) &&
    !isAnthropicReasoningRoute(route) &&
    !isOpenAICompletionsRoute(route)
  );
}

function isGitHubCopilotResponsesRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    (route?.api === "openai-responses" || route?.api === "openclaw-openai-responses-transport") &&
    route.provider === "github-copilot"
  );
}

function isStructurallyValidOpaqueReplayToken(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    OPAQUE_REPLAY_TOKEN_RE.test(value) &&
    !value.includes("\u2026")
  );
}

function isCredentialSafeOpaqueReplayToken(value: string): boolean {
  if (!isStructurallyValidOpaqueReplayToken(value)) {
    return false;
  }
  // OpenAI encrypted reasoning is commonly Fernet-shaped and intentionally
  // matches the generic gAAAA secret detector. Custom routes retain the
  // credential-sensitive gate because their opaque fields are not attributable
  // to a known provider contract.
  return value.startsWith("gAAAA") || redactSensitiveText(value, { mode: "tools" }) === value;
}

function isGoogleThoughtSignature(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u2026") &&
    GOOGLE_THOUGHT_SIGNATURE_RE.test(value)
  );
}

function resolveTranscriptAssistantRoute(
  source: Record<string, unknown>,
  cfg: OpenClawConfig | undefined,
): TranscriptAssistantRoute {
  const api = typeof source.api === "string" ? source.api : undefined;
  const model = typeof source.model === "string" ? source.model : undefined;
  const provider = typeof source.provider === "string" ? source.provider : undefined;
  const providerConfig = provider
    ? findNormalizedProviderValue(cfg?.models?.providers, provider)
    : undefined;
  const modelConfig = model
    ? providerConfig?.models?.find((candidate) => candidate.id === model)
    : undefined;
  const baseUrl = modelConfig?.baseUrl ?? providerConfig?.baseUrl;
  const endpointClass = baseUrl ? resolveProviderEndpoint(baseUrl).endpointClass : undefined;
  return {
    ...(api ? { api } : {}),
    ...(endpointClass ? { endpointClass } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function isSafeReplayIdentifier(value: string, maxLength = 512): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    /^[A-Za-z0-9+/_:.=-]+$/.test(value) &&
    redactSensitiveText(value, { mode: "tools" }) === value
  );
}

function isOpenAIResponseItemId(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  return isSafeReplayIdentifier(value, isGitHubCopilotResponsesRoute(route) ? 64 : 512);
}

function isOpenAITextSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || !isPlainTranscriptObject(parsed)) {
        return false;
      }
      if (!Object.keys(parsed).every((key) => key === "v" || key === "id" || key === "phase")) {
        return false;
      }
      const id =
        typeof parsed.id === "string" && isOpenAIResponseItemId(parsed.id, route)
          ? parsed.id
          : undefined;
      const phase =
        parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
      if (parsed.id !== undefined && id === undefined) {
        return false;
      }
      return parsed.v === 1 && (id !== undefined || phase !== undefined);
    } catch {
      return false;
    }
  }
  return isOpenAIResponseItemId(value, route);
}

const OPENAI_REASONING_REPLAY_METADATA_KEYS = new Set([
  "v",
  "source",
  "provider",
  "api",
  "model",
  "baseUrlHash",
  "sessionHash",
  "authProfileHash",
]);
const OPENAI_REASONING_REPLAY_METADATA_KEY = "__openclaw_replay";

function sanitizeOpenAIReasoningReplayMetadata(
  value: unknown,
  route: TranscriptAssistantRoute | undefined,
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !isPlainTranscriptObject(value) ||
    !route?.api ||
    !route.model ||
    !route.provider
  ) {
    return undefined;
  }
  if (
    value.v !== 1 ||
    value.source !== "openai-responses" ||
    value.provider !== route?.provider ||
    value.api !== route.api ||
    value.model !== route.model ||
    (value.baseUrlHash !== undefined &&
      (typeof value.baseUrlHash !== "string" ||
        !OPENAI_REPLAY_CONTEXT_HASH_RE.test(value.baseUrlHash))) ||
    (value.sessionHash !== undefined &&
      (typeof value.sessionHash !== "string" ||
        !OPENAI_REPLAY_CONTEXT_HASH_RE.test(value.sessionHash))) ||
    (value.authProfileHash !== undefined &&
      (typeof value.authProfileHash !== "string" ||
        !OPENAI_REPLAY_CONTEXT_HASH_RE.test(value.authProfileHash)))
  ) {
    return undefined;
  }
  if (Object.keys(value).every((key) => OPENAI_REASONING_REPLAY_METADATA_KEYS.has(key))) {
    return value;
  }
  return {
    v: 1,
    source: "openai-responses",
    provider: value.provider,
    api: value.api,
    model: value.model,
    ...(value.baseUrlHash !== undefined ? { baseUrlHash: value.baseUrlHash } : {}),
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
  };
}

function shouldPreserveOpaqueProviderPayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  location: TranscriptValueLocation,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  if (location !== "assistant-content-block" || typeof item !== "string") {
    return false;
  }
  const type = source.type;
  const isAnthropicSlot =
    (type === "thinking" && (key === "thinkingSignature" || key === "signature")) ||
    (type === "redacted_thinking" &&
      (key === "data" || key === "signature" || key === "thinkingSignature"));
  if (isAnthropicReasoningRoute(route) && isAnthropicSlot) {
    return isStructurallyValidOpaqueReplayToken(item);
  }
  const isGoogleSlot =
    (type === "text" && key === "textSignature") ||
    (type === "thinking" && (key === "thinkingSignature" || key === "thought_signature")) ||
    (type === "toolCall" && key === "thoughtSignature");
  if (isGoogleReasoningRoute(route) && isGoogleSlot) {
    return isGoogleThoughtSignature(item);
  }
  if (isGoogleOpenAICompletionsRoute(route) && type === "toolCall" && key === "thoughtSignature") {
    // The OpenAI-compatible transport captures provider-owned opaque signatures
    // such as SIG-OPAQUE-ABC==; native Google routes require standard base64.
    return isStructurallyValidOpaqueReplayToken(item);
  }
  if (!isCustomProviderRoute(route) || !isCredentialSafeOpaqueReplayToken(item)) {
    return false;
  }
  return (
    (type === "text" && key === "textSignature") ||
    (type === "thinking" &&
      (key === "thinkingSignature" || key === "signature" || key === "thought_signature")) ||
    (type === "redacted_thinking" &&
      (key === "data" || key === "signature" || key === "thinkingSignature")) ||
    (type === "toolCall" && key === "thoughtSignature")
  );
}

function sanitizeOpenAIReasoningSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !isPlainTranscriptObject(parsed) ||
    parsed.type !== "reasoning" ||
    (parsed.summary !== undefined && !Array.isArray(parsed.summary))
  ) {
    return undefined;
  }
  const encryptedContent = parsed.encrypted_content;
  const hasEncryptedContent = Object.hasOwn(parsed, "encrypted_content");
  const isValidEncryptedContent = isOpenAIResponsesRoute(route)
    ? isStructurallyValidOpaqueReplayToken
    : isCredentialSafeOpaqueReplayToken;
  if (
    encryptedContent !== undefined &&
    encryptedContent !== null &&
    (typeof encryptedContent !== "string" || !isValidEncryptedContent(encryptedContent))
  ) {
    return undefined;
  }
  if (
    parsed.id !== undefined &&
    (typeof parsed.id !== "string" || !isOpenAIResponseItemId(parsed.id, route))
  ) {
    return undefined;
  }
  if (
    parsed.status !== undefined &&
    parsed.status !== "in_progress" &&
    parsed.status !== "completed" &&
    parsed.status !== "incomplete"
  ) {
    return undefined;
  }
  if (!hasEncryptedContent && typeof parsed.id !== "string") {
    return undefined;
  }
  const replayMetadata = sanitizeOpenAIReasoningReplayMetadata(
    parsed[OPENAI_REASONING_REPLAY_METADATA_KEY],
    route,
  );
  return JSON.stringify({
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    type: "reasoning",
    summary: [],
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(hasEncryptedContent ? { encrypted_content: encryptedContent } : {}),
    ...(replayMetadata ? { [OPENAI_REASONING_REPLAY_METADATA_KEY]: replayMetadata } : {}),
  });
}

function sanitizeOpenAICompletionsToolSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const isValidEncryptedData = isOpenAICompletionsRoute(route)
    ? isStructurallyValidOpaqueReplayToken
    : isCredentialSafeOpaqueReplayToken;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !isPlainTranscriptObject(parsed) ||
    parsed.type !== "reasoning.encrypted" ||
    typeof parsed.data !== "string" ||
    !isValidEncryptedData(parsed.data) ||
    (parsed.id !== undefined &&
      parsed.id !== null &&
      (typeof parsed.id !== "string" || !isSafeReplayIdentifier(parsed.id))) ||
    (parsed.format !== undefined &&
      parsed.format !== null &&
      (typeof parsed.format !== "string" ||
        parsed.format.length > 64 ||
        !/^[a-z0-9.-]+$/.test(parsed.format))) ||
    (parsed.index !== undefined &&
      (!Number.isSafeInteger(parsed.index) || (parsed.index as number) < 0))
  ) {
    return undefined;
  }
  return JSON.stringify({
    type: "reasoning.encrypted",
    data: parsed.data,
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.format !== undefined ? { format: parsed.format } : {}),
    ...(parsed.index !== undefined ? { index: parsed.index } : {}),
  });
}

function redactTranscriptStructuredValue(
  value: unknown,
  cfg?: OpenClawConfig,
  fieldKey?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
  preserveImageDataUrlFields = false,
  location: TranscriptValueLocation = "nested",
  assistantRoute?: TranscriptAssistantRoute,
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg);
    }
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(
        item,
        cfg,
        fieldKey,
        seen,
        preserveImageDataUrlFields,
        location === "assistant-content-array" ? "assistant-content-block" : "nested",
        assistantRoute,
      );
      changed ||= next !== item;
      return next;
    });
    seen.delete(value);
    return changed ? redacted : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    // Avoid recursive transcript payloads from escaping redaction or crashing
    // persistence; circular refs serialize as a stable marker.
    return "[Circular]";
  }
  if (!isPlainTranscriptObject(value)) {
    // Non-plain instances can carry runtime state; leave them untouched instead
    // of cloning unexpected prototypes into transcripts.
    return value;
  }

  seen.add(value);
  const sanitizedImageRecord = sanitizeImageRecord(value);
  const source = sanitizedImageRecord ?? value;
  const currentAssistantRoute =
    location === "root" && source.role === "assistant"
      ? resolveTranscriptAssistantRoute(source, cfg)
      : assistantRoute;
  let next: Record<string, unknown> | null = null;
  if (source !== value) {
    next = { ...source };
  }
  for (const [key, item] of Object.entries(source)) {
    if (
      location === "assistant-content-block" &&
      (isOpenAIResponsesRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "thinking" &&
      key === "openclawReasoningReplay"
    ) {
      const sanitizedMetadata = sanitizeOpenAIReasoningReplayMetadata(item, currentAssistantRoute);
      if (sanitizedMetadata !== undefined) {
        if (sanitizedMetadata !== item) {
          next ??= { ...source };
          next[key] = sanitizedMetadata;
        }
        continue;
      }
    }
    if (
      location === "assistant-content-block" &&
      (isOpenAIResponsesRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "thinking" &&
      key === "thinkingSignature" &&
      typeof item === "string"
    ) {
      const sanitizedSignature = sanitizeOpenAIReasoningSignature(item, currentAssistantRoute);
      if (sanitizedSignature !== undefined) {
        if (sanitizedSignature !== item) {
          next ??= { ...source };
          next[key] = sanitizedSignature;
        }
        continue;
      }
    }
    if (
      location === "assistant-content-block" &&
      (isOpenAIResponsesRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "text" &&
      key === "textSignature" &&
      typeof item === "string" &&
      isOpenAITextSignature(item, currentAssistantRoute)
    ) {
      continue;
    }
    if (
      location === "assistant-content-block" &&
      (isOpenAICompletionsRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "toolCall" &&
      key === "thoughtSignature" &&
      typeof item === "string"
    ) {
      const sanitizedSignature = sanitizeOpenAICompletionsToolSignature(
        item,
        currentAssistantRoute,
      );
      if (sanitizedSignature !== undefined) {
        if (sanitizedSignature !== item) {
          next ??= { ...source };
          next[key] = sanitizedSignature;
        }
        continue;
      }
    }
    // Provider-signed/encrypted bytes must remain exact or replayed tool turns fail.
    if (shouldPreserveOpaqueProviderPayload(source, key, item, location, currentAssistantRoute)) {
      continue;
    }
    if (typeof item === "string") {
      const sanitizedDataUrl =
        preserveImageDataUrlFields && key === "url"
          ? startsWithDataUrl(item)
            ? sanitizeInlineImageDataUrlForStorage(item)
            : undefined
          : sanitizeImageDataUrlField(source, key, item);
      if (sanitizedDataUrl !== undefined) {
        if (sanitizedDataUrl !== item) {
          next ??= { ...source };
          next[key] = sanitizedDataUrl;
        }
        continue;
      }
    }
    if (shouldPreserveOpaqueImagePayload(source, key, item, preserveImageDataUrlFields)) {
      continue;
    }
    const redacted = redactTranscriptStructuredValue(
      item,
      cfg,
      key,
      seen,
      preserveImageDataUrlFields || shouldPreserveNestedImageDataUrlFields(source, key),
      location === "root" && source.role === "assistant" && key === "content" && Array.isArray(item)
        ? "assistant-content-array"
        : "nested",
      currentAssistantRoute,
    );
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  seen.delete(value);
  return next ?? value;
}

/** Return a redacted transcript message according to logging config. */
export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  if (isTranscriptRedactionDisabled(cfg)) {
    return message;
  }
  return redactTranscriptStructuredValue(
    message,
    cfg,
    undefined,
    new WeakSet<object>(),
    false,
    "root",
  ) as AgentMessage;
}
