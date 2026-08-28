import { OPENAI_RESPONSES_APIS } from "@openclaw/ai/internal/openai-responses-payload-policy";
/**
 * Agent transcript redaction helpers.
 *
 * Applies logging redaction rules to persisted messages while preserving unchanged object identity.
 */
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import { redactSourceInputTextWithConfig } from "../logging/redact-source.js";
import {
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactSensitiveText,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";
import type { ProviderEndpointClass } from "./provider-attribution.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import type { AgentMessage } from "./runtime/index.js";
import { isTranscriptToolCallBlock, sanitizeTranscriptToolCallBlock } from "./tool-call-shared.js";
import {
  copyCodeModeSourceAppend,
  readCodeModeSourceFields,
  type CodeModeSourceAppend,
} from "./transcript-code-mode-source.js";
import {
  sanitizeTranscriptImageDataUrlField,
  sanitizeTranscriptImageRecord,
  shouldPreserveNestedTranscriptImageDataUrlFields,
  shouldPreserveTranscriptImagePayload,
} from "./transcript-redact-images.js";
import { sanitizeCompactionReplayState } from "./transcript-redact-replay.js";

function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const redactPatterns = cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns;
  return redactPatterns ? { redactPatterns } : undefined;
}

function redactTranscriptText(
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  const loggingConfig = resolveTranscriptLoggingConfig(cfg);
  return modelVisibleToolResult
    ? redactModelVisibleToolPayloadTextWithConfig(value, loggingConfig)
    : redactToolPayloadTextWithConfig(value, loggingConfig);
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  // Preserve pagination state only in transcripts; value-pattern and global log redaction remain.
  return /^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i.test(key)
    ? redactTranscriptText(value, cfg, modelVisibleToolResult)
    : modelVisibleToolResult
      ? redactModelVisibleSensitiveFieldValueWithConfig(
          key,
          value,
          resolveTranscriptLoggingConfig(cfg),
        )
      : redactSensitiveFieldValueWithConfig(key, value, resolveTranscriptLoggingConfig(cfg));
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
// Transport replay fences use the two-word base-36 output from shortHash.
const OPENAI_REPLAY_CONTEXT_HASH_RE = /^[a-z0-9]{2,16}$/;

function isOpenAIReplayContextHash(value: unknown): value is string {
  return typeof value === "string" && OPENAI_REPLAY_CONTEXT_HASH_RE.test(value);
}

function isOpenAIResponsesApi(api: string): boolean {
  return OPENAI_RESPONSES_APIS.has(api);
}

function isOpenAIResponsesRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && isOpenAIResponsesApi(route.api);
}

function isGoogleReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && GOOGLE_REASONING_APIS.has(route.api);
}

function isAnthropicReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && ANTHROPIC_REASONING_APIS.has(route.api);
}

const isOpenAICompletionsRoute = (route?: TranscriptAssistantRoute) =>
  OPENAI_COMPLETIONS_APIS.has(route?.api ?? "");

function isGoogleOpenAICompletionsRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    isOpenAICompletionsRoute(route) &&
    (route?.provider === "google" ||
      route?.endpointClass === "google-generative-ai" ||
      route?.endpointClass === "google-vertex")
  );
}

function isVeniceGeminiOpenAICompletionsRoute(
  route: TranscriptAssistantRoute | undefined,
): boolean {
  return (
    isOpenAICompletionsRoute(route) &&
    route?.provider === "venice" &&
    typeof route.model === "string" &&
    /(?:^|\/)gemini-/.test(route.model.trim().toLowerCase())
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

const replaySanitizerHelpers = {
  isAnthropicReasoningRoute,
  isOpenAIReplayContextHash,
  isOpenAIResponseItemId,
  isOpenAIResponsesApi,
  isOpenAIResponsesRoute,
  isPlainTranscriptObject,
  isStructurallyValidOpaqueReplayToken,
  redactTranscriptText,
};

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
    (value.baseUrlHash !== undefined && !isOpenAIReplayContextHash(value.baseUrlHash)) ||
    (value.sessionHash !== undefined && !isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined && !isOpenAIReplayContextHash(value.authProfileHash))
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
  if (
    (isGoogleOpenAICompletionsRoute(route) || isVeniceGeminiOpenAICompletionsRoute(route)) &&
    type === "toolCall" &&
    key === "thoughtSignature"
  ) {
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
  modelVisibleToolResult = false,
  sourceFields?: ReadonlyMap<string, string>,
  sourceSlots?: ReadonlyMap<object, ReadonlyMap<string, string>>,
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg, modelVisibleToolResult);
    }
    return redactTranscriptText(value, cfg, modelVisibleToolResult);
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
        modelVisibleToolResult,
        undefined,
        sourceSlots,
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
  // Continuation attachment snapshots are durable handoff input, not replayable
  // transcript content. Apply the shared tool-call projection before any
  // canonical writer serializes an assistant message (not only CLI mirroring).
  const sanitizedToolCall: Record<string, unknown> = isTranscriptToolCallBlock(value)
    ? sanitizeTranscriptToolCallBlock(value)
    : value;
  const sanitizedImageRecord = sanitizeTranscriptImageRecord(sanitizedToolCall);
  const source = sanitizedImageRecord ?? sanitizedToolCall;
  const currentAssistantRoute =
    location === "root" && source.role === "assistant"
      ? resolveTranscriptAssistantRoute(source, cfg)
      : assistantRoute;
  let next: Record<string, unknown> | null = null;
  if (source !== value) {
    next = { ...source };
  }
  for (const [key, item] of Object.entries(source)) {
    // The append transaction owns this control-plane identity. Redacting it would
    // make stored dedupe disagree with the admitted message identity.
    if (location === "root" && key === "idempotencyKey") {
      continue;
    }
    // Correlation keys must match live events; nested payload lookalikes are still redacted.
    if (
      typeof item === "string" &&
      ((location === "root" && source.role === "toolResult" && key === "toolCallId") ||
        (location === "assistant-content-block" && source.type === "toolCall" && key === "id"))
    ) {
      continue;
    }
    if (location === "root" && source.role === "assistant" && key === "providerReplay") {
      const sanitizedReplay = sanitizeCompactionReplayState(
        item,
        currentAssistantRoute,
        cfg,
        replaySanitizerHelpers,
      );
      if (sanitizedReplay !== undefined) {
        if (sanitizedReplay !== item) {
          next ??= { ...source };
          next[key] = sanitizedReplay;
        }
        continue;
      }
      next ??= { ...source };
      delete next[key];
      continue;
    }
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
      // These transports use the same validated v1 phase signature for pre-tool commentary;
      // stripping it would resurface narration after reload or session resume.
      (isOpenAIResponsesRoute(currentAssistantRoute) ||
        isOpenAICompletionsRoute(currentAssistantRoute) ||
        isAnthropicReasoningRoute(currentAssistantRoute) ||
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
      const sanitizedDataUrl = sanitizeTranscriptImageDataUrlField({
        source,
        key,
        value: item,
        preserveImageDataUrlFields,
      });
      if (sanitizedDataUrl !== undefined) {
        if (sanitizedDataUrl !== item) {
          next ??= { ...source };
          next[key] = sanitizedDataUrl;
        }
        continue;
      }
    }
    if (shouldPreserveTranscriptImagePayload(source, key, item, preserveImageDataUrlFields)) {
      continue;
    }
    const redacted =
      typeof item === "string" && sourceFields?.get(key) === item
        ? redactSourceInputTextWithConfig(item, resolveTranscriptLoggingConfig(cfg))
        : redactTranscriptStructuredValue(
            item,
            cfg,
            key,
            seen,
            preserveImageDataUrlFields ||
              shouldPreserveNestedTranscriptImageDataUrlFields(source, key),
            location === "root" &&
              source.role === "assistant" &&
              key === "content" &&
              Array.isArray(item)
              ? "assistant-content-array"
              : "nested",
            currentAssistantRoute,
            modelVisibleToolResult ||
              (location === "root" && source.role === "toolResult" && key === "content"),
            location === "assistant-content-block" && key === "arguments"
              ? sourceSlots?.get(source)
              : undefined,
            sourceSlots,
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
export function redactTranscriptMessage(
  message: AgentMessage,
  cfg?: OpenClawConfig,
  sourceAppend?: CodeModeSourceAppend,
): AgentMessage {
  const redacted = redactTranscriptStructuredValue(
    message,
    cfg,
    undefined,
    new WeakSet<object>(),
    false,
    "root",
    undefined,
    false,
    undefined,
    readCodeModeSourceFields(message, sourceAppend),
  ) as AgentMessage;
  copyCodeModeSourceAppend(message, redacted, sourceAppend, (source) =>
    redactSourceInputTextWithConfig(source, resolveTranscriptLoggingConfig(cfg)),
  );
  return redacted;
}
