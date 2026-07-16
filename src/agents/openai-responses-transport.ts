/**
 * OpenAI Responses transport for Azure variants, replay, reasoning, and payload policy.
 */
import { randomUUID } from "node:crypto";
import {
  createResponsesToolCallTracker,
  isOpenAICompatibleAzureResponsesBaseUrl,
  isResponsesTextContentPartType,
  isResponsesTextDeltaEventType,
  normalizeOpenAIReasoningEffort,
  normalizeOpenAIStrictToolParameters,
  projectOpenAITools,
  readResponsesToolCallItemIdentity,
  reconcileOpenAIResponsesToolChoice,
  resolveAzureDeploymentNameFromMap,
  resolveOpenAIReasoningEffortForModel,
  resolveResponsesMessageSnapshotCollapse,
  type OpenAIApiReasoningEffort,
  type OpenAIReasoningEffort,
  type OpenAIToolProjection,
  type ResponsesToolCallState,
} from "@openclaw/ai/internal/openai";
import {
  calculateCost,
  createFirstStreamEventAbortController,
  getEnvApiKey,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  parseStreamingJson,
  withFirstStreamEventTimeout,
} from "@openclaw/ai/internal/runtime";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
  stripSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import OpenAI, { AzureOpenAI } from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFormatTextConfig,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import { sha256HexPrefix } from "../infra/crypto-digest.js";
import type { Api, Context, Model } from "../llm/types.js";
import "../llm/ai-transport-host.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderTransportTurnStateWithPlugin } from "../plugins/provider-runtime.js";
import {
  emitModelTransportDebug,
  resolveModelPayloadDebugMode,
  resolveModelSseDebugMode,
} from "./model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import { resolveReplayableResponsesMessageId } from "./openai-responses-replay.js";
import { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
  isOpenAICodexResponsesModel,
  resolveOpenAIStrictToolFlagWithDiagnostics,
  usesNativeOpenAICodexResponsesBackend,
} from "./openai-transport-params.js";
import {
  createModelStreamCooperativeScheduler,
  log,
  resolveCacheRetention,
  resolvePromptCacheKey,
  sortTransportToolsByName,
  throwIfModelStreamAborted,
  type BaseOpenAIStreamOptions,
  type MutableAssistantOutput,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import type { StreamFn } from "./runtime/index.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  assignTransportErrorDetails,
  mergeTransportMetadata,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

const DEFAULT_AZURE_OPENAI_API_VERSION = "preview";
const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
const OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS = "Follow the user request.";
const AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS = 30_000;
const RESPONSE_FAILED_NO_DETAILS_MESSAGE = "Unknown error (no error details in response)";
const OPENAI_RESPONSES_REASONING_REPLAY_META_KEY = "__openclaw_replay";
const OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY = "openclawReasoningReplay";
const OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH = 64;

type ReplayableResponseOutputMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };
type OpenAIResponsesReasoningReplayMetadata = {
  v: 1;
  source: "openai-responses";
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};
type ReplayableResponseReasoningItem = Omit<ResponseReasoningItem, "id"> & {
  id?: string;
  [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]?: OpenAIResponsesReasoningReplayMetadata;
};
type ResponsesClientLike = ReturnType<typeof createOpenAIResponsesClient>;

type OpenAIResponsesOptions = BaseOpenAIStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  replayResponsesItemIds?: boolean;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
};

type OpenAIResponsesReplayContext = {
  provider: string;
  api: Api;
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};

function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function stringifyJsonLike(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function getServiceTierCostMultiplier(serviceTier: ResponseCreateParamsStreaming["service_tier"]) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: MutableAssistantOutput["usage"],
  serviceTier?: ResponseCreateParamsStreaming["service_tier"],
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function safeDebugValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function responseInputTextChars(input: unknown): number {
  if (typeof input === "string") {
    return input.length;
  }
  if (Array.isArray(input)) {
    return input.reduce((total, item) => total + responseInputTextChars(item), 0);
  }
  if (!input || typeof input !== "object") {
    return 0;
  }
  const record = input as Record<string, unknown>;
  let total = 0;
  if (typeof record.text === "string") {
    total += record.text.length;
  }
  if (typeof record.content === "string") {
    total += record.content.length;
  } else if (Array.isArray(record.content)) {
    total += responseInputTextChars(record.content);
  }
  return total;
}

function responseInputRoles(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }
  const roles = new Set<string>();
  for (const item of input) {
    if (item && typeof item === "object") {
      const role = (item as Record<string, unknown>).role;
      if (typeof role === "string" && role.trim()) {
        roles.add(role.trim());
      }
    }
  }
  return [...roles].toSorted().join(",");
}

function readToolPayloadField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

function readResponsesToolDisplayName(tool: unknown): string {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  const record = tool as Record<string, unknown>;
  const name = readToolPayloadField(record, "name");
  if (typeof name === "string") {
    return name;
  }
  const fn = readToolPayloadField(record, "function");
  if (fn && typeof fn === "object") {
    const fnName = readToolPayloadField(fn as Record<string, unknown>, "name");
    if (typeof fnName === "string") {
      return fnName;
    }
  }
  const type = readToolPayloadField(record, "type");
  return typeof type === "string" && type !== "function" ? type : "";
}

function summarizeResponsesTools(tools: unknown): string {
  if (!Array.isArray(tools)) {
    return "count=0";
  }
  const names = tools.map(readResponsesToolDisplayName).filter(Boolean);
  const mode = resolveModelPayloadDebugMode();
  const maxNames = mode === "tools" || mode === "full-redacted" ? names.length : 12;
  const label = maxNames >= names.length ? "names" : "sample";
  const shown = names.slice(0, maxNames).join(",");
  return `count=${tools.length}${shown ? ` ${label}=${shown}` : ""}`;
}

function stringifyRedactedPayload(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) {
      return "<empty>";
    }
    const redacted = redactSensitiveText(encoded, { mode: "tools" });
    return redacted.length > 8000 ? `${truncateUtf16Safe(redacted, 8000)}…<truncated>` : redacted;
  } catch {
    return "<unserializable>";
  }
}

function stringifyRedactedEvent(value: unknown): string {
  const redacted = stringifyRedactedPayload(value);
  return redacted.length > 2000 ? `${truncateUtf16Safe(redacted, 2000)}…<truncated>` : redacted;
}

type ResponsesFailedNoDetailsObservation = {
  event: "openai_responses_response_failed_without_details";
  provider: string;
  api: Api;
  transportModel: string;
  providerRuntimeFailureKind: "no_error_details";
  responseId: string;
  responseStatus: string;
  responseModel: string;
  responseObject: string;
  metadataKeys: string[];
  requestIdHashes: string[];
  failureFieldsPreview: string;
  responsePreview: string;
};

type ResponsesFailedEventSummary = {
  message: string;
  responseId?: string;
  observation?: ResponsesFailedNoDetailsObservation;
};

const RESPONSE_FAILED_FAILURE_FIELD_KEYS = [
  "error",
  "incomplete_details",
  "status_details",
  "failure_reason",
  "last_error",
  "provider_error",
  "error_details",
] as const;

function readResponseFailedString(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  return stringifyUnknown(record?.[key]);
}

function buildResponsesFailedEventSummary(
  message: string,
  responseId: string | undefined,
  observation?: ResponsesFailedNoDetailsObservation,
): ResponsesFailedEventSummary {
  const summary: ResponsesFailedEventSummary = { message };
  if (responseId) {
    summary.responseId = responseId;
  }
  if (observation) {
    summary.observation = observation;
  }
  return summary;
}

function isResponseFailedIdentifierKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    normalized === "requestid" ||
    normalized === "xrequestid" ||
    normalized === "providerrequestid" ||
    normalized === "providerresponseid" ||
    normalized === "litellmrequestid" ||
    (normalized.includes("request") && normalized.endsWith("id")) ||
    (normalized.includes("provider") && normalized.endsWith("id"))
  );
}

function collectResponseFailedIdentifierHashes(
  value: unknown,
  opts: {
    path?: string;
    depth?: number;
    identifierKey?: string;
    out?: string[];
    seen?: WeakSet<object>;
  } = {},
): string[] {
  const path = opts.path ?? "";
  const depth = opts.depth ?? 0;
  const identifierKey = opts.identifierKey ?? "";
  const out = opts.out ?? [];
  const seen = opts.seen ?? new WeakSet<object>();
  if (out.length >= 12 || depth > 4 || !value || typeof value !== "object") {
    return out;
  }
  if (seen.has(value)) {
    return out;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (index >= 8 || out.length >= 12) {
        break;
      }
      const itemString =
        typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
      if (identifierKey && isResponseFailedIdentifierKey(identifierKey) && itemString) {
        out.push(`${path}[${index}]=${redactIdentifier(itemString, { len: 12 })}`);
        continue;
      }
      collectResponseFailedIdentifierHashes(item, {
        path: `${path}[${index}]`,
        depth: depth + 1,
        identifierKey,
        out,
        seen,
      });
    }
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= 12) {
      break;
    }
    const childPath = path ? `${path}.${key}` : key;
    const childString =
      typeof child === "string" || typeof child === "number" ? String(child).trim() : "";
    if (isResponseFailedIdentifierKey(key) && childString) {
      out.push(`${childPath}=${redactIdentifier(childString, { len: 12 })}`);
      continue;
    }
    collectResponseFailedIdentifierHashes(child, {
      path: childPath,
      depth: depth + 1,
      identifierKey: isResponseFailedIdentifierKey(key) ? key : undefined,
      out,
      seen,
    });
  }
  return out;
}

function redactResponseFailedDiagnosticValue(
  value: unknown,
  opts: {
    key?: string;
    depth?: number;
    seen?: WeakSet<object>;
  } = {},
): unknown {
  const key = opts.key ?? "";
  const depth = opts.depth ?? 0;
  if (typeof value === "string" || typeof value === "number") {
    return key && isResponseFailedIdentifierKey(key)
      ? redactIdentifier(String(value), { len: 12 })
      : value;
  }
  if (depth > 6 || !value || typeof value !== "object") {
    return value;
  }
  const seen = opts.seen ?? new WeakSet<object>();
  if (seen.has(value)) {
    return "<circular>";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) =>
      redactResponseFailedDiagnosticValue(item, {
        key,
        depth: depth + 1,
        seen,
      }),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactResponseFailedDiagnosticValue(child, {
      key: childKey,
      depth: depth + 1,
      seen,
    });
  }
  return out;
}

function buildResponsesFailedFailureFields(
  response: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!response) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const key of RESPONSE_FAILED_FAILURE_FIELD_KEYS) {
    if (response[key] !== undefined && response[key] !== null) {
      fields[key] = response[key];
    }
  }
  return fields;
}

function buildResponsesFailedNoDetailsObservation(
  event: Record<string, unknown>,
  model: Model,
  response: Record<string, unknown> | undefined = isRecord(event.response)
    ? event.response
    : undefined,
): ResponsesFailedNoDetailsObservation {
  const failureFields = redactResponseFailedDiagnosticValue(
    buildResponsesFailedFailureFields(response),
  ) as Record<string, unknown>;
  const metadataKeys = isRecord(response?.metadata)
    ? Object.keys(response.metadata).toSorted()
    : [];
  const responsePreview = {
    id: readResponseFailedString(response, "id"),
    status: readResponseFailedString(response, "status"),
    model: readResponseFailedString(response, "model"),
    object: readResponseFailedString(response, "object"),
    failureFields,
    metadataKeys,
  };
  return {
    event: "openai_responses_response_failed_without_details",
    provider: model.provider,
    api: model.api,
    transportModel: model.id,
    providerRuntimeFailureKind: "no_error_details",
    responseId: responsePreview.id,
    responseStatus: responsePreview.status,
    responseModel: responsePreview.model,
    responseObject: responsePreview.object,
    metadataKeys,
    requestIdHashes: collectResponseFailedIdentifierHashes(event),
    failureFieldsPreview: stringifyRedactedEvent(failureFields),
    responsePreview: stringifyRedactedEvent(responsePreview),
  };
}

function summarizeResponsesFailedNoDetailsObservation(
  observation: ResponsesFailedNoDetailsObservation,
): string {
  const requestIds = observation.requestIdHashes.join(",");
  const metadataKeys = observation.metadataKeys.join(",");
  return (
    `responseId=${safeDebugValue(observation.responseId || undefined)} ` +
    `responseStatus=${safeDebugValue(observation.responseStatus || undefined)} ` +
    `responseModel=${safeDebugValue(observation.responseModel || undefined)} ` +
    `requestIds=${requestIds || "none"} metadataKeys=${metadataKeys || "none"} ` +
    `failureFields=${observation.failureFieldsPreview}`
  );
}

function normalizeResponsesFailedEvent(
  event: Record<string, unknown>,
  model: Model,
): ResponsesFailedEventSummary {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = readResponseFailedString(response, "id") || undefined;
  const error = isRecord(response?.error) ? response.error : undefined;
  if (error) {
    const code = readResponseFailedString(error, "code").trim();
    const message = readResponseFailedString(error, "message").trim();
    if (code || message) {
      return buildResponsesFailedEventSummary(
        `${code || "unknown"}: ${message || "no message"}`,
        responseId,
      );
    }
  }
  const incompleteDetails = isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const incompleteReason = readResponseFailedString(incompleteDetails, "reason");
  if (incompleteReason) {
    return buildResponsesFailedEventSummary(`incomplete: ${incompleteReason}`, responseId);
  }
  return buildResponsesFailedEventSummary(
    RESPONSE_FAILED_NO_DETAILS_MESSAGE,
    responseId,
    buildResponsesFailedNoDetailsObservation(event, model, response),
  );
}

function logResponsesFailedNoDetails(observation: ResponsesFailedNoDetailsObservation): void {
  log.warn(
    `[responses] response.failed missing error details provider=${observation.provider} ` +
      `api=${observation.api} model=${observation.transportModel} ` +
      summarizeResponsesFailedNoDetailsObservation(observation),
    observation,
  );
}

function summarizeResponsesPayload(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "payload=non-object";
  }
  const record = params as Record<string, unknown>;
  const input = record.input;
  const reasoning =
    record.reasoning && typeof record.reasoning === "object"
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const text =
    record.text && typeof record.text === "object"
      ? (record.text as Record<string, unknown>)
      : undefined;
  const parts = [
    `fields=${Object.keys(record).toSorted().join(",")}`,
    `model=${safeDebugValue(record.model)}`,
    `stream=${safeDebugValue(record.stream)}`,
    `inputItems=${Array.isArray(input) ? input.length : typeof input}`,
    `inputRoles=${responseInputRoles(input) || "none"}`,
    `inputTextChars=${responseInputTextChars(input)}`,
    `tools=${summarizeResponsesTools(record.tools)}`,
    `reasoningEffort=${safeDebugValue(reasoning?.effort)}`,
    `reasoningSummary=${safeDebugValue(reasoning?.summary)}`,
    `textVerbosity=${safeDebugValue(text?.verbosity)}`,
    `serviceTier=${safeDebugValue(record.service_tier)}`,
    `store=${safeDebugValue(record.store)}`,
    `promptCacheKey=${record.prompt_cache_key === undefined ? "absent" : "present"}`,
    `metadataKeys=${
      record.metadata && typeof record.metadata === "object"
        ? Object.keys(record.metadata).toSorted().join(",")
        : "none"
    }`,
  ];
  if (resolveModelPayloadDebugMode() === "full-redacted") {
    parts.push(`payload=${stringifyRedactedPayload(record)}`);
  }
  return parts.join(" ");
}

function summarizeOpenAITransportError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return `type=${typeof error} message=${safeDebugValue(error)}`;
  }
  const record = error as Record<string, unknown>;
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : undefined;
  return [
    `name=${safeDebugValue(record.name)}`,
    `status=${safeDebugValue(record.status)}`,
    `code=${safeDebugValue(record.code)}`,
    `type=${safeDebugValue(record.type)}`,
    `causeName=${safeDebugValue(cause?.name)}`,
    `causeCode=${safeDebugValue(cause?.code)}`,
    `message=${error instanceof Error ? error.message : safeDebugValue(error)}`,
  ].join(" ");
}

function isInvalidEncryptedContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; status?: unknown };
  if (record.code === "invalid_encrypted_content" || record.code === "thinking_signature_invalid") {
    return true;
  }
  const message = typeof record.message === "string" ? record.message : "";
  return (
    message.includes("invalid_encrypted_content") ||
    message.includes("thinking_signature_invalid") ||
    // xAI reports this exact prose contract without an error code.
    (record.status === 400 &&
      message.toLowerCase().includes("could not decrypt the provided encrypted_content"))
  );
}

function stripEncryptedContentFields(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripEncryptedContentFields(item);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return changed ? { value: next, changed: true } : { value, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "encrypted_content") {
      changed = true;
      continue;
    }
    const stripped = stripEncryptedContentFields(child);
    changed ||= stripped.changed;
    next[key] = stripped.value;
  }
  return changed ? { value: next, changed: true } : { value, changed: false };
}

function stripResponsesRequestEncryptedContent(
  params: OpenAIResponsesRequestParams,
): OpenAIResponsesRequestParams {
  const stripped = stripEncryptedContentFields(params.input);
  if (!stripped.changed) {
    return params;
  }
  return {
    ...params,
    input: stripped.value as ResponseInput,
  };
}

function hashOptionalReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

function buildOpenAIResponsesReplayContext(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashOptionalReplayContextValue(model.baseUrl),
    sessionHash: hashOptionalReplayContextValue(options?.sessionId),
    authProfileHash: hashOptionalReplayContextValue(options?.authProfileId),
  };
}

function buildOpenAIResponsesReasoningReplayMetadata(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReasoningReplayMetadata {
  return {
    v: 1,
    source: "openai-responses",
    ...buildOpenAIResponsesReplayContext(model, options),
  };
}

function tagOpenAIResponsesReasoningReplayItem(
  item: Record<string, unknown>,
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): Record<string, unknown> {
  if (!("encrypted_content" in item)) {
    return item;
  }
  return {
    ...item,
    [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: buildOpenAIResponsesReasoningReplayMetadata(
      model,
      options,
    ),
  };
}

function isOpenAIResponsesReasoningReplayMetadata(
  value: unknown,
): value is OpenAIResponsesReasoningReplayMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.source === "openai-responses" &&
    typeof record.provider === "string" &&
    typeof record.api === "string" &&
    typeof record.model === "string" &&
    (record.baseUrlHash === undefined || typeof record.baseUrlHash === "string") &&
    (record.sessionHash === undefined || typeof record.sessionHash === "string") &&
    (record.authProfileHash === undefined || typeof record.authProfileHash === "string")
  );
}

function encryptedReasoningReplayMetadataMatches(
  metadata: OpenAIResponsesReasoningReplayMetadata | undefined,
  context: OpenAIResponsesReplayContext,
): boolean {
  if (!metadata) {
    return false;
  }
  return (
    metadata.provider === context.provider &&
    metadata.api === context.api &&
    metadata.model === context.model &&
    metadata.baseUrlHash === context.baseUrlHash &&
    metadata.sessionHash === context.sessionHash &&
    metadata.authProfileHash === context.authProfileHash
  );
}

function readOpenAIResponsesReasoningReplayBlockMetadata(
  block: Record<string, unknown>,
): OpenAIResponsesReasoningReplayMetadata | undefined {
  const value = block[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY];
  return isOpenAIResponsesReasoningReplayMetadata(value) ? value : undefined;
}

function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
): ReplayableResponseReasoningItem {
  const record = item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (record.type !== "reasoning" || Array.isArray(record.summary)) {
    return item;
  }
  return { ...record, summary: [] } as ReplayableResponseReasoningItem;
}

function prepareOpenAIResponsesReasoningItemForReplay(
  item: ReplayableResponseReasoningItem,
  context: OpenAIResponsesReplayContext,
  blockMetadata?: OpenAIResponsesReasoningReplayMetadata,
): ReplayableResponseReasoningItem {
  const { [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]: rawMetadata, ...rest } =
    item as ReplayableResponseReasoningItem & Record<string, unknown>;
  if (!("encrypted_content" in rest)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const metadata =
    blockMetadata ??
    (isOpenAIResponsesReasoningReplayMetadata(rawMetadata) ? rawMetadata : undefined);
  if (encryptedReasoningReplayMetadataMatches(metadata, context)) {
    return normalizeOpenAIResponsesReasoningReplayItem(rest as ReplayableResponseReasoningItem);
  }
  const stripped = stripEncryptedContentFields(rest);
  return normalizeOpenAIResponsesReasoningReplayItem(
    stripped.value as ReplayableResponseReasoningItem,
  );
}

async function createResponsesStreamWithEncryptedContentRetry(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: unknown;
  model: Model;
}): Promise<AsyncIterable<unknown>> {
  try {
    return (await params.client.responses.create(
      params.request as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  } catch (error) {
    const retryRequest = stripResponsesRequestEncryptedContent(params.request);
    if (!isInvalidEncryptedContentError(error) || retryRequest === params.request) {
      throw error;
    }
    log.warn(
      `[responses] retrying without encrypted reasoning content provider=${params.model.provider} ` +
        `api=${params.model.api} model=${params.model.id}`,
    );
    return (await params.client.responses.create(
      retryRequest as never,
      params.requestOptions as never,
    )) as unknown as AsyncIterable<unknown>;
  }
}

function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function shortHash(value: string): string {
  return sha256HexPrefix(value, 16);
}

function normalizeResponsesReplayItemId(
  id: string | undefined,
  prefix: string,
): string | undefined {
  if (!id) {
    return undefined;
  }
  if (id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH) {
    return id;
  }
  return `${prefix}_${shortHash(id)}`;
}

function isSafeResponsesReplayItemId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH
  );
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id?: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1) {
        const id = typeof parsed.id === "string" ? parsed.id : undefined;
        const phase =
          parsed.phase === "commentary" || parsed.phase === "final_answer"
            ? parsed.phase
            : undefined;
        // A reasoning-dropped replay keeps the phase but omits the paired id.
        if (id !== undefined || phase !== undefined) {
          return { id, phase };
        }
        return undefined;
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

function buildResponsesInputMessage(
  role: "user" | "system" | "developer",
  content: ResponseInputMessageContentList,
): ResponseInputItem.Message {
  return { type: "message", role, content };
}

function convertResponsesMessages(
  model: Model,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: {
    includeSystemPrompt?: boolean;
    supportsDeveloperRole?: boolean;
    replayReasoningItems?: boolean;
    replayResponsesItemIds?: boolean;
    sessionId?: string;
    authProfileId?: string;
  },
): ResponseInput {
  const messages: ResponseInput = [];
  const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
  const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
  const replayContext = buildOpenAIResponsesReplayContext(model, {
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
  });
  const shouldNormalizeSameModelToolCallIds = model.provider === "github-copilot";
  const sanitizeIdPart = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "");
  const normalizeIdPart = (part: string) => {
    const sanitized = sanitizeIdPart(part);
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const buildSameProviderCopilotResponsesItemId = (itemId: string) => {
    const sanitized = sanitizeIdPart(itemId);
    const candidate = sanitized.startsWith("fc_") ? sanitized : `fc_${sanitized}`;
    return candidate.length > 64 ? buildForeignResponsesItemId(itemId) : candidate;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const separatorIndex = id.indexOf("|");
    const callId = id.slice(0, separatorIndex);
    const itemId = id.slice(separatorIndex + 1);
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : model.provider === "github-copilot"
        ? buildSameProviderCopilotResponsesItemId(itemId)
        : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
    { normalizeSameModelToolCallIds: shouldNormalizeSameModelToolCallIds },
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push(
      buildResponsesInputMessage(
        model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
        [
          {
            type: "input_text",
            text: sanitizeTransportPayloadText(
              stripSystemPromptCacheBoundary(context.systemPrompt),
            ),
          },
        ],
      ),
    );
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push(
          buildResponsesInputMessage("user", [
            { type: "input_text", text: sanitizeTransportPayloadText(msg.content) },
          ]),
        );
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push(buildResponsesInputMessage("user", content));
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      let textFallbackOrdinal = 0;
      let previousReplayItemWasReasoning = false;
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (
            shouldReplayReasoningItems &&
            block.thinkingSignature &&
            block.thinkingSignature.startsWith("{")
          ) {
            // openai-completions plain-text reasoning paths persist a
            // provenance tag (e.g. "reasoning", "reasoning_details", "content")
            // as thinkingSignature rather than a JSON-encoded reasoning item.
            // Replaying those values would corrupt the next request payload
            // (OpenRouter returns HTTP 500), so skip non-JSON signatures.
            const reasoningItem = JSON.parse(
              block.thinkingSignature,
            ) as ReplayableResponseReasoningItem;
            const replayableReasoningItem = prepareOpenAIResponsesReasoningItemForReplay(
              reasoningItem,
              replayContext,
              readOpenAIResponsesReasoningReplayBlockMetadata(
                block as unknown as Record<string, unknown>,
              ),
            );
            if (!shouldReplayResponsesItemIds) {
              delete replayableReasoningItem.id;
            }
            if (
              shouldReplayResponsesItemIds &&
              model.provider === "github-copilot" &&
              !isSafeResponsesReplayItemId(replayableReasoningItem.id)
            ) {
              continue;
            }
            output.push(replayableReasoningItem as ResponseInputItem);
            previousReplayItemWasReasoning = true;
          }
        } else if (block.type === "text") {
          const textSignature = parseTextSignature(block.textSignature);
          let msgId = resolveReplayableResponsesMessageId({
            replayResponsesItemIds: shouldReplayResponsesItemIds,
            textSignatureId: textSignature?.id,
            fallbackId: `msg_${msgIndex}`,
            fallbackOrdinal: textFallbackOrdinal,
            previousReplayItemWasReasoning,
          });
          if (!textSignature?.id) {
            textFallbackOrdinal += 1;
          }
          msgId = normalizeResponsesReplayItemId(msgId, "msg");
          const messageItem: ReplayableResponseOutputMessage = {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            ...(msgId ? { id: msgId } : {}),
            phase: textSignature?.phase,
          };
          output.push(messageItem as ResponseInputItem);
          previousReplayItemWasReasoning = false;
        } else if (block.type === "toolCall") {
          const separatorIndex = block.id.indexOf("|");
          const callId = separatorIndex === -1 ? block.id : block.id.slice(0, separatorIndex);
          const itemIdRaw = separatorIndex === -1 ? undefined : block.id.slice(separatorIndex + 1);
          const itemId =
            shouldReplayResponsesItemIds && !(isDifferentModel && itemIdRaw?.startsWith("fc_"))
              ? itemIdRaw
              : undefined;
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
          previousReplayItemWasReasoning = false;
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const sanitizedTextResult = sanitizeTransportPayloadText(textResult);
      const hasText = sanitizedTextResult.trim().length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);
      const hasImages = msg.content.some(isImageWithMediaPayload);
      const separatorIndex = msg.toolCallId.indexOf("|");
      const callId =
        separatorIndex === -1 ? msg.toolCallId : msg.toolCallId.slice(0, separatorIndex);
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(hasText
                  ? [{ type: "input_text", text: sanitizedTextResult }]
                  : mediaPlaceholder === "(see attached media)"
                    ? [{ type: "input_text", text: mediaPlaceholder }]
                    : []),
                ...msg.content.filter(isImageWithMediaPayload).map((item) => ({
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeNonEmptyTransportPayloadText(textResult, mediaPlaceholder ?? "(no output)"),
      });
    }
    msgIndex += 1;
  }
  return messages;
}

function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  model: OpenAIModeModel,
  options?: { strict?: boolean | null },
): { projection: OpenAIToolProjection; tools: FunctionTool[] } {
  const projection = projectOpenAITools(tools);
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(projection, options?.strict, {
    transport: "responses",
    model,
  });
  return {
    projection,
    tools: sortTransportToolsByName(projection.tools).map((tool): FunctionTool => {
      const result = {
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: normalizeOpenAIStrictToolParameters(
          tool.parameters,
          strict === true,
          model.compat,
        ),
      } as FunctionTool;
      if (strict !== undefined) {
        result.strict = strict;
      }
      return result;
    }),
  };
}

async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
    firstEventTimeoutMs?: number;
    abortFirstEventStream?: (reason: Error) => void;
    onFirstEventTimeout?: (reason: Error) => void;
    signal?: AbortSignal;
    sessionId?: string;
    authProfileId?: string;
  },
) {
  const resolveToolCallId = (item: Record<string, unknown>, fallbackId?: string): string => {
    const callId = stringifyUnknown(item.call_id).trim();
    const itemId = stringifyUnknown(item.id).trim();
    const [fallbackCallId = "", fallbackItemId = ""] = (fallbackId ?? "").split("|");
    const resolvedCallId = callId || fallbackCallId;
    const resolvedItemId = itemId || fallbackItemId;
    if (resolvedCallId) {
      return resolvedItemId ? `${resolvedCallId}|${resolvedItemId}` : resolvedCallId;
    }
    const generatedCallId = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    return resolvedItemId ? `${generatedCallId}|${resolvedItemId}` : generatedCallId;
  };
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  type StreamingToolCallState = ResponsesToolCallState & {
    block: Record<string, unknown>;
    contentIndex: number;
  };
  const streamingToolCalls = createResponsesToolCallTracker<StreamingToolCallState>();
  let lastTextBlock: {
    block: Record<string, unknown>;
    index: number;
    phase: "commentary" | "final_answer" | undefined;
  } | null = null;
  // While a message item may still be a cumulative snapshot of lastTextBlock,
  // its public block is deferred so a collapsed item never leaves an
  // unbalanced text_start behind (#91959). null = no deferral in progress.
  let pendingMessageText: string | null = null;
  const streamStartedAt = Date.now();
  let eventCount = 0;
  const eventTypes = new Map<string, number>();
  const sseDebugMode = resolveModelSseDebugMode();
  const blockIndex = () => output.content.length - 1;
  const readIdentityValue = (value: unknown): string | undefined => {
    const identity = typeof value === "string" ? value.trim() : "";
    return identity || undefined;
  };
  // Opening fragments may carry the only function name. A conflicting
  // completion must never retarget an already-started call.
  const resolveCompletedToolCallName = (
    toolCall: StreamingToolCallState | undefined,
    value: unknown,
  ): string => {
    const streamedName = readIdentityValue(toolCall?.block.name);
    const completedName = readIdentityValue(value);
    if (streamedName && completedName && streamedName !== completedName) {
      throw new Error(
        `Responses stream changed tool-call function name from ${streamedName} to ${completedName}`,
      );
    }
    const name = completedName ?? streamedName;
    if (!name) {
      throw new Error("Responses stream completed tool call without a function name");
    }
    return name;
  };
  const appendPendingMessageDelta = (delta: string) => {
    pendingMessageText = `${pendingMessageText ?? ""}${delta}`;
    const priorText = stringifyUnknown(lastTextBlock?.block.text);
    if (priorText.startsWith(pendingMessageText) || pendingMessageText.startsWith(priorText)) {
      return;
    }
    // Diverged from the prior text: this is a distinct message, so open its
    // block now and replay the withheld text as one delta.
    const phase =
      currentItem?.type === "message"
        ? ((currentItem.phase as "commentary" | "final_answer" | undefined) ?? undefined)
        : undefined;
    currentBlock = {
      type: "text",
      text: pendingMessageText,
      ...(currentItem?.type === "message" && phase
        ? {
            textSignature: encodeTextSignatureV1(stringifyUnknown(currentItem.id), phase),
          }
        : {}),
    };
    output.content.push(currentBlock);
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: pendingMessageText });
    pendingMessageText = null;
  };
  const appendCompletedResponseTextItem = (item: Record<string, unknown>) => {
    const text = readResponsesOutputMessageText(item);
    if (!text) {
      return;
    }
    const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
    const collapse = resolveResponsesMessageSnapshotCollapse({
      prior: lastTextBlock && {
        text: stringifyUnknown(lastTextBlock.block.text),
        phase: lastTextBlock.phase,
      },
      nextText: text,
      nextPhase: phase,
    });
    if (collapse.kind === "extend" && lastTextBlock) {
      // Cumulative snapshot of the prior message item: replace, don't append;
      // the newest item's signature carries the content for replay (#91959).
      lastTextBlock.block.text = collapse.text;
      lastTextBlock.block.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), phase);
      stream.push({
        type: "text_end",
        contentIndex: lastTextBlock.index,
        content: collapse.text,
        partial: output,
      });
      return;
    }
    const block: Record<string, unknown> = {
      type: "text",
      text,
      textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase),
    };
    output.content.push(block);
    lastTextBlock = { block, index: blockIndex(), phase };
    stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "text_end",
      contentIndex: blockIndex(),
      content: text,
      partial: output,
    });
  };
  const appendCompletedResponseToolCallItem = (item: Record<string, unknown>) => {
    const args = parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
    const name = resolveCompletedToolCallName(undefined, item.name);
    const block = {
      type: "toolCall",
      id: resolveToolCallId(item),
      name,
      arguments: args,
      partialJson: stringifyJsonLike(item.arguments, "{}"),
    };
    output.content.push(block);
    stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex: blockIndex(),
      toolCall: {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: args,
      },
      partial: output,
    });
  };
  const backfillCompletedResponseOutput = (response: Record<string, unknown> | undefined) => {
    if (output.content.length > 0 || !Array.isArray(response?.output)) {
      return;
    }
    for (const rawItem of response.output) {
      if (!isRecord(rawItem)) {
        continue;
      }
      if (rawItem.type === "message") {
        appendCompletedResponseTextItem(rawItem);
        continue;
      }
      // Any non-message item (reasoning, tool call) is a real boundary; a later
      // message must not collapse across it, mirroring the streaming path.
      lastTextBlock = null;
      if (rawItem.type === "function_call") {
        appendCompletedResponseToolCallItem(rawItem);
      }
    }
  };
  const guardedStream = withFirstStreamEventTimeout(openaiStream, {
    provider: model.provider,
    api: model.api,
    model: model.id,
    timeoutMs: options?.firstEventTimeoutMs ?? 0,
    stage: "responses",
    abort: options?.abortFirstEventStream,
    onTimeout: options?.onFirstEventTimeout,
    hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools.",
  });
  const cooperativeScheduler = createModelStreamCooperativeScheduler(options?.signal);
  for await (const rawEvent of guardedStream) {
    throwIfModelStreamAborted(options?.signal);
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    eventCount += 1;
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    if (eventCount === 1) {
      emitModelTransportDebug(
        log,
        `[responses] first_event provider=${model.provider} api=${model.api} model=${model.id} ` +
          `elapsedMs=${Date.now() - streamStartedAt} type=${type}`,
      );
    }
    if (sseDebugMode === "peek" && eventCount <= 5) {
      emitModelTransportDebug(
        log,
        `[responses] event_peek provider=${model.provider} api=${model.api} model=${model.id} ` +
          `index=${eventCount} type=${type} event=${stringifyRedactedEvent(event)}`,
      );
    }
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item.type !== "message") {
        // Snapshot collapse only applies to back-to-back message items; any
        // other item is a real boundary (see resolveResponsesMessageSnapshotCollapse).
        lastTextBlock = null;
        pendingMessageText = null;
      }
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        if (lastTextBlock) {
          currentBlock = null;
          pendingMessageText = "";
        } else {
          const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
          currentBlock = {
            type: "text",
            text: "",
            ...(phase
              ? { textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase) }
              : {}),
          };
          output.content.push(currentBlock);
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
      } else if (item.type === "function_call") {
        const toolCallBlock: Record<string, unknown> = {
          type: "toolCall",
          id: resolveToolCallId(item),
          name: readIdentityValue(item.name) ?? "",
          arguments: {},
          partialJson: stringifyJsonLike(item.arguments),
        };
        const contentIndex = output.content.length;
        const toolCallState: StreamingToolCallState = {
          block: toolCallBlock,
          contentIndex,
          argumentStreamReliable: true,
          ...readResponsesToolCallItemIdentity(item),
        };
        streamingToolCalls.register(event, toolCallState);
        currentItem = item;
        currentBlock = toolCallBlock;
        output.content.push(toolCallBlock);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (isResponsesTextDeltaEventType(type) || type === "response.refusal.delta") {
      if (currentItem?.type === "message") {
        if (pendingMessageText !== null) {
          appendPendingMessageDelta(stringifyUnknown(event.delta));
        } else if (currentBlock?.type === "text") {
          currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: stringifyUnknown(event.delta),
          });
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const toolCall = streamingToolCalls.resolve(event);
      if (toolCall) {
        toolCall.block.partialJson = `${stringifyJsonLike(toolCall.block.partialJson)}${stringifyJsonLike(event.delta)}`;
        toolCall.block.arguments = parseStreamingJson(
          stringifyJsonLike(toolCall.block.partialJson),
        );
        stream.push({
          type: "toolcall_delta",
          contentIndex: toolCall.contentIndex,
          delta: stringifyJsonLike(event.delta),
          partial: output,
        });
      } else if (streamingToolCalls.hasActive()) {
        streamingToolCalls.markArgumentsUnreliable();
      }
    } else if (type === "response.function_call_arguments.done") {
      const toolCall = streamingToolCalls.resolve(event);
      if (toolCall) {
        const previousPartialJson = stringifyJsonLike(toolCall.block.partialJson);
        const doneArguments = typeof event.arguments === "string" ? event.arguments : undefined;
        if (
          doneArguments !== undefined &&
          (doneArguments.length > 0 || previousPartialJson === "")
        ) {
          toolCall.block.partialJson = doneArguments;
          toolCall.block.arguments = parseStreamingJson(doneArguments);
          toolCall.argumentStreamReliable = true;
        }
        if (doneArguments?.startsWith(previousPartialJson)) {
          const delta = doneArguments.slice(previousPartialJson.length);
          if (delta.length > 0) {
            stream.push({
              type: "toolcall_delta",
              contentIndex: toolCall.contentIndex,
              delta,
              partial: output,
            });
          }
        }
      } else if (streamingToolCalls.hasActive()) {
        streamingToolCalls.markArgumentsUnreliable();
      }
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type !== "message") {
        lastTextBlock = null;
        pendingMessageText = null;
      }
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .map((part) => {
                const summaryPart = part as { text?: string };
                return summaryPart.text ?? "";
              })
              .join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        if ("encrypted_content" in item) {
          currentBlock[OPENAI_RESPONSES_REASONING_REPLAY_BLOCK_META_KEY] =
            buildOpenAIResponsesReasoningReplayMetadata(model, {
              authProfileId: options?.authProfileId,
              sessionId: options?.sessionId,
            });
        }
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.thinking),
          partial: output,
        });
        currentBlock = null;
      } else if (
        item.type === "message" &&
        (currentBlock?.type === "text" || pendingMessageText !== null)
      ) {
        const content = Array.isArray(item.content) ? item.content : [];
        const finalText = content
          .map((part) => {
            const contentPart = part as { type?: string; text?: string; refusal?: string };
            return isResponsesTextContentPartType(contentPart.type)
              ? (contentPart.text ?? "")
              : (contentPart.refusal ?? "");
          })
          .join("");
        const phase = (item.phase as "commentary" | "final_answer" | undefined) ?? undefined;
        const collapse =
          pendingMessageText !== null
            ? resolveResponsesMessageSnapshotCollapse({
                prior: lastTextBlock && {
                  text: stringifyUnknown(lastTextBlock.block.text),
                  phase: lastTextBlock.phase,
                },
                nextText: finalText,
                nextPhase: phase,
              })
            : ({ kind: "keep" } as const);
        pendingMessageText = null;
        if (collapse.kind === "extend" && lastTextBlock) {
          // Cumulative snapshot of the prior message item: replace its text
          // instead of appending another copy. The deferred block was never
          // started publicly, and the newest item's signature is kept so
          // replay carries the item that produced this content (#91959).
          lastTextBlock.block.text = collapse.text;
          lastTextBlock.block.textSignature = encodeTextSignatureV1(
            stringifyUnknown(item.id),
            phase,
          );
          stream.push({
            type: "text_end",
            contentIndex: lastTextBlock.index,
            content: collapse.text,
            partial: output,
          });
        } else {
          if (currentBlock?.type !== "text") {
            // Deferred distinct message: open its block now, balanced with the
            // text_end below.
            currentBlock = {
              type: "text",
              text: "",
              ...(phase
                ? { textSignature: encodeTextSignatureV1(stringifyUnknown(item.id), phase) }
                : {}),
            };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text = finalText;
          currentBlock.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), phase);
          lastTextBlock = { block: currentBlock, index: blockIndex(), phase };
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: stringifyUnknown(currentBlock.text),
            partial: output,
          });
        }
        currentBlock = null;
      } else if (item.type === "function_call") {
        const streamingToolCall = streamingToolCalls.resolve(
          event,
          readResponsesToolCallItemIdentity(item),
        );
        // Do not turn an unresolved completion into a second public call while
        // an indexed call is still open. Its identity or index must match.
        if (!streamingToolCall && streamingToolCalls.hasActive()) {
          await cooperativeScheduler.afterEvent();
          continue;
        }
        const completedName = resolveCompletedToolCallName(streamingToolCall, item.name);
        const streamedPartialJson = streamingToolCall
          ? stringifyJsonLike(streamingToolCall.block.partialJson)
          : "";
        const completedArguments = typeof item.arguments === "string" ? item.arguments : undefined;
        if (streamingToolCall && !streamingToolCall.argumentStreamReliable && !completedArguments) {
          await cooperativeScheduler.afterEvent();
          continue;
        }
        const finalPartialJson =
          completedArguments !== undefined &&
          (completedArguments.length > 0 || !streamedPartialJson)
            ? completedArguments
            : streamedPartialJson || "{}";
        const args = parseStreamingJson(finalPartialJson);
        let toolCallBlock: Record<string, unknown>;
        let contentIndex: number;
        if (streamingToolCall) {
          toolCallBlock = streamingToolCall.block;
          contentIndex = streamingToolCall.contentIndex;
        } else {
          toolCallBlock = {
            type: "toolCall",
            id: resolveToolCallId(item),
            name: completedName,
            arguments: args,
            partialJson: finalPartialJson,
          };
          output.content.push(toolCallBlock);
          contentIndex = blockIndex();
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        }
        const provisionalId = typeof toolCallBlock.id === "string" ? toolCallBlock.id : undefined;
        const currentToolCallId = resolveToolCallId(item, provisionalId);
        toolCallBlock.id = currentToolCallId;
        toolCallBlock.name = completedName;
        toolCallBlock.arguments = args;
        toolCallBlock.partialJson = finalPartialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: currentToolCallId,
            name: completedName,
            arguments: args,
          },
          partial: output,
        });
        if (streamingToolCall) {
          streamingToolCalls.forget(streamingToolCall);
        }
        if (currentBlock === toolCallBlock) {
          currentBlock = null;
          currentItem = null;
        }
      }
    } else if (type === "response.completed") {
      if (streamingToolCalls.hasActive()) {
        throw new Error("Responses stream completed with unresolved tool calls");
      }
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      backfillCompletedResponseOutput(response);
      const usage = response?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
            output_tokens_details?: { reasoning_tokens?: number };
            service_tier?: ResponseCreateParamsStreaming["service_tier"];
            status?: string;
          }
        | undefined;
      if (usage) {
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
        const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens || 0;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
        const input = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
        output.usage = {
          input,
          output: outputTokens,
          cacheRead: cachedTokens,
          cacheWrite: cacheWriteTokens,
          ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
            ? { reasoningTokens }
            : {}),
          totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model as never, output.usage as never);
      if (options?.applyServiceTierPricing) {
        options.applyServiceTierPricing(
          output.usage,
          (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
            options.serviceTier,
        );
      }
      output.stopReason = mapResponsesStopReason(response?.status as string | undefined);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const failure = normalizeResponsesFailedEvent(event, model);
      if (failure.responseId) {
        output.responseId = failure.responseId;
      }
      if (failure.observation) {
        logResponsesFailedNoDetails(failure.observation);
      }
      throw new Error(failure.message);
    }
    await cooperativeScheduler.afterEvent();
  }
  if (streamingToolCalls.hasActive()) {
    throw new Error("Responses stream ended with unresolved tool calls");
  }
  const eventTypeSummary = [...eventTypes.entries()]
    .slice(0, 12)
    .map(([eventType, count]) => `${eventType}:${count}`)
    .join(",");
  emitModelTransportDebug(
    log,
    `[responses] stream_done provider=${model.provider} api=${model.api} model=${model.id} ` +
      `elapsedMs=${Date.now() - streamStartedAt} events=${eventCount} types=${eventTypeSummary} ` +
      `stopReason=${output.stopReason ?? "unset"} contentBlocks=${output.content.length}`,
  );
}

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

function readResponsesOutputMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "output_text" || part.type === "text") {
        return stringifyUnknown(part.text);
      }
      if (part.type === "refusal") {
        return stringifyUnknown(part.refusal);
      }
      return "";
    })
    .join("");
}

function resolveProviderTransportTurnState(
  model: Model,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  const normalizedProvider = model.provider.trim().toLowerCase();
  const allowRuntimePluginLoad =
    normalizedProvider === "openai" ||
    normalizedProvider === "azure-openai" ||
    normalizedProvider === "azure-openai-responses";
  return resolveProviderTransportTurnStateWithPlugin({
    provider: model.provider,
    modelId: model.id,
    allowRuntimePluginLoad,
    context: {
      provider: model.provider,
      modelId: model.id,
      model: model as ProviderRuntimeModel,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    },
  });
}

function createOpenAIResponsesClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
  sessionId?: string,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders, sessionId),
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createOpenAIResponsesClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
          options?.sessionId,
        );
        let params = buildOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (!isOpenAICodexResponsesModel(model)) {
          params = mergeTransportMetadata(params, turnState?.metadata);
        }
        params = sanitizeOpenAICodexResponsesParams(
          model,
          params as Record<string, unknown>,
        ) as typeof params;
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
          stream: true,
        });
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = await createResponsesStreamWithEncryptedContentRetry({
          client,
          request: params,
          requestOptions,
          model,
        });
        emitModelTransportDebug(
          log,
          `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - requestStartedAt}`,
        );
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          serviceTier: responsesOptions?.serviceTier,
          applyServiceTierPricing,
          firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
          signal: options?.signal,
          authProfileId: responsesOptions?.authProfileId,
          sessionId: options?.sessionId,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

function resolveOpenAIReasoningEffort(
  options: OpenAIResponsesOptions | undefined,
): OpenAIApiReasoningEffort {
  return normalizeOpenAIReasoningEffort(
    options?.reasoningEffort ?? options?.reasoning ?? "high",
  ) as OpenAIApiReasoningEffort;
}

function hasResponsesWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    if (!isRecord(tool)) {
      return false;
    }
    if (tool.type === "web_search") {
      return true;
    }
    if (tool.type === "function" && tool.name === "web_search") {
      return true;
    }
    const fn = tool.function;
    return isRecord(fn) && fn.name === "web_search";
  });
}

function raiseMinimalReasoningForResponsesWebSearch(params: {
  model: Model;
  effort: OpenAIApiReasoningEffort;
  tools: unknown;
}): OpenAIApiReasoningEffort {
  if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) {
    return params.effort;
  }
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveOpenAIReasoningEffortForModel({
      model: params.model,
      effort,
    });
    if (resolved && resolved !== "none" && resolved !== "minimal") {
      return resolved;
    }
  }
  return params.effort;
}

const OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "service_tier",
  "temperature",
  "top_p",
] as const;

function stripOpenAICodexResponsesUnsupportedTextFields(params: Record<string, unknown>): void {
  const text = params.text;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    return;
  }
  const sanitizedText = { ...(text as Record<string, unknown>) };
  delete sanitizedText.format;
  if (Object.keys(sanitizedText).length > 0) {
    params.text = sanitizedText;
  } else {
    delete params.text;
  }
}

function sanitizeOpenAICodexResponsesParams<T extends Record<string, unknown>>(
  model: Model,
  params: T,
): T {
  if (!usesNativeOpenAICodexResponsesBackend(model)) {
    return params;
  }
  for (const key of OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS) {
    delete params[key];
  }
  stripOpenAICodexResponsesUnsupportedTextFields(params);
  return params;
}

function buildOpenAICodexResponsesInstructions(context: Context): string | undefined {
  if (!context.systemPrompt) {
    return undefined;
  }
  return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}

function resolveOpenAICodexResponsesInstructions(
  model: Model,
  context: Context,
): string | undefined {
  const instructions = buildOpenAICodexResponsesInstructions(context);
  if (instructions && instructions.trim().length > 0) {
    return instructions;
  }
  return usesNativeOpenAICodexResponsesBackend(model)
    ? OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS
    : undefined;
}

function ensureOpenAICodexResponsesInput(messages: ResponseInput, context: Context): void {
  if (messages.length > 0 || !context.systemPrompt) {
    return;
  }
  const text = buildOpenAICodexResponsesInstructions(context);
  if (!text) {
    throw new Error(
      "OpenAI Codex Responses requires non-empty input when only systemPrompt is provided.",
    );
  }
  messages.push(
    buildResponsesInputMessage("user", [
      { type: "input_text", text: OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT },
    ]),
  );
}

function resolveOpenAIResponsesTextFormat(
  responseFormat: Record<string, unknown>,
): ResponseFormatTextConfig {
  if (
    responseFormat.type === "json_schema" &&
    responseFormat.json_schema &&
    typeof responseFormat.json_schema === "object" &&
    !Array.isArray(responseFormat.json_schema)
  ) {
    return {
      ...(responseFormat.json_schema as Record<string, unknown>),
      type: "json_schema",
    } as unknown as ResponseFormatTextConfig;
  }
  return responseFormat as unknown as ResponseFormatTextConfig;
}

function buildOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  metadata?: Record<string, string>,
) {
  const isCodexResponses = isOpenAICodexResponsesModel(model);
  const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const policyAllowsReplayIds =
    payloadPolicy.explicitStore !== false && !payloadPolicy.shouldStripStore;
  const replayResponsesItemIds =
    !isNativeCodexResponses && (options?.replayResponsesItemIds ?? policyAllowsReplayIds);
  const messages = convertResponsesMessages(
    model,
    context,
    new Set(["openai", "opencode", "azure-openai-responses", "github-copilot"]),
    {
      includeSystemPrompt: !isCodexResponses,
      supportsDeveloperRole,
      replayReasoningItems: true,
      replayResponsesItemIds,
      authProfileId: options?.authProfileId,
      sessionId: options?.sessionId,
    },
  );
  if (isCodexResponses) {
    ensureOpenAICodexResponsesInput(messages, context);
  }
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: promptCacheKey,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    ...(isCodexResponses
      ? { instructions: resolveOpenAICodexResponsesInstructions(model, context) }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
  const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
  if (effectiveMaxTokens) {
    params.max_output_tokens = effectiveMaxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    params.top_p = options.topP;
  }
  if (options?.responseFormat !== undefined) {
    params.text = {
      ...params.text,
      format: resolveOpenAIResponsesTextFormat(options.responseFormat),
    };
  }
  if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    const converted = convertResponsesTools(context.tools, model as OpenAIModeModel, {
      strict: resolveOpenAIStrictToolSetting(model as OpenAIModeModel, {
        transport: "stream",
      }),
    });
    if (
      converted.tools.length > 0 ||
      (converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0)
    ) {
      params.tools = converted.tools;
    }
    if (options?.toolChoice) {
      const toolChoice = reconcileOpenAIResponsesToolChoice(
        options.toolChoice,
        converted.projection,
      );
      if (toolChoice !== undefined) {
        params.tool_choice = toolChoice;
      }
    }
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
      const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
      const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: requestedReasoningEffort,
      });
      const reasoningEffort = resolvedReasoningEffort
        ? raiseMinimalReasoningForResponsesWebSearch({
            model,
            effort: resolvedReasoningEffort,
            tools: params.tools,
          })
        : undefined;
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
          ...(reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }),
        };
        if (reasoningEffort !== "none") {
          params.include = ["reasoning.encrypted_content"];
        }
      }
    } else if (model.provider !== "github-copilot") {
      const reasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
      });
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
        };
      }
    }
  }
  applyOpenAIResponsesPayloadPolicy(params as Record<string, unknown>, payloadPolicy);
  return sanitizeOpenAICodexResponsesParams(
    model,
    params as Record<string, unknown>,
  ) as typeof params;
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: "azure-openai-responses",
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createAzureOpenAIClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          responsesOptions,
          deploymentName,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (!isOpenAICodexResponsesModel(model)) {
          params = mergeTransportMetadata(params, turnState?.metadata);
        }
        params = sanitizeOpenAICodexResponsesParams(
          model,
          params as Record<string, unknown>,
        ) as typeof params;
        params = sanitizeResponsesImagePayload(params as Record<string, unknown>) as typeof params;
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          enforceCodeModeResponsesToolSurface(params);
          assertCodeModeResponsesToolSurface(params);
        }
        const requestStartedAt = Date.now();
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEventAbort.signal);
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseStream = (await client.responses.create(
          params as never,
          requestOptions,
        )) as unknown as AsyncIterable<unknown>;
        emitModelTransportDebug(
          log,
          `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
            `elapsedMs=${Date.now() - requestStartedAt}`,
        );
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          firstEventTimeoutMs:
            getFirstStreamEventTimeoutMs(options) ?? AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
          signal: options?.signal,
          authProfileId: responsesOptions?.authProfileId,
          sessionId: options?.sessionId,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        log.warn(
          `[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error),
        );
        assignTransportErrorDetails(output, error, options?.signal);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model): string {
  return resolveAzureDeploymentNameFromMap({
    modelId: model.id,
    deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
  });
}

function createAzureOpenAIClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  const baseURL = normalizeAzureBaseUrl(model.baseUrl);
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    baseURL,
    fetch: buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  };

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) {
    return new OpenAI(clientOptions);
  }

  return new AzureOpenAI({
    ...clientOptions,
    apiVersion: resolveAzureOpenAIApiVersion(),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
  metadata?: Record<string, string>,
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata);
  params.model = deploymentName;
  delete params.store;
  return params;
}

type OpenAIResponsesRequestParams = {
  model: string;
  input: ResponseInput;
  stream: true;
  instructions?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  metadata?: Record<string, string>;
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  text?: ResponseCreateParamsStreaming["text"];
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  tool_choice?: ResponseCreateParamsStreaming["tool_choice"];
  reasoning?:
    | { effort: OpenAIApiReasoningEffort }
    | {
        effort: OpenAIApiReasoningEffort;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
};

const responsesTesting = {
  getCompat,
  assertCodeModeResponsesToolSurface,
  buildOpenAIResponsesParams,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  createAzureOpenAIClient,
  createOpenAIResponsesClient,
  enforceCodeModeResponsesToolSurface,
  sanitizeOpenAICodexResponsesParams,
  processResponsesStream,
  formatModelTransportDebugBaseUrl,
  buildResponsesFailedNoDetailsObservation,
  buildOpenAIResponsesReasoningReplayMetadata,
  isInvalidEncryptedContentError,
  normalizeResponsesFailedEvent,
  prepareOpenAIResponsesReasoningItemForReplay,
  createResponsesStreamWithEncryptedContentRetry,
  resolveAzureOpenAIApiVersion,
  stripResponsesRequestEncryptedContent,
  tagOpenAIResponsesReasoningReplayItem,
  summarizeResponsesFailedNoDetailsObservation,
  summarizeResponsesPayload,
  summarizeResponsesTools,
  stringifyRedactedEvent,
  stringifyRedactedPayload,
};

declare global {
  var openclawOpenAIResponsesTransportTestApi: typeof responsesTesting | undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  globalThis.openclawOpenAIResponsesTransportTestApi = responsesTesting;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
