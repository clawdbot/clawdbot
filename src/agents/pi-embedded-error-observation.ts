import { readLoggingConfig } from "../logging/config.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import {
  classifyProviderRuntimeFailureKind,
  getApiErrorPayloadFingerprint,
  parseApiErrorInfo,
  type ProviderRuntimeFailureKind,
} from "./pi-embedded-helpers.js";
import { stableStringify } from "./stable-stringify.js";

export { sanitizeForConsole } from "./console-sanitize.js";

const MAX_OBSERVATION_INPUT_CHARS = 64_000;
const MAX_FINGERPRINT_MESSAGE_CHARS = 8_000;
const RAW_ERROR_PREVIEW_MAX_CHARS = 400;
const PROVIDER_ERROR_PREVIEW_MAX_CHARS = 200;
const REQUEST_ID_RE = /\brequest[_ ]?id\b\s*[:=]\s*["'()]*([A-Za-z0-9._:-]+)/i;
const OBSERVATION_EXTRA_REDACT_PATTERNS = [
  String.raw`\b(?:x-)?api[-_]?key\b\s*[:=]\s*(["']?)([^\s"'\\;]+)\1`,
  String.raw`"(?:api[-_]?key|api_key)"\s*:\s*"([^"]+)"`,
  String.raw`(?:\bCookie\b\s*[:=]\s*[^;=\s]+=|;\s*[^;=\s]+=)([^;\s\r\n]+)`,
];

function resolveConfiguredRedactPatterns(): string[] {
  const configured = readLoggingConfig()?.redactPatterns;
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured.filter((pattern): pattern is string => typeof pattern === "string");
}

function truncateForObservation(text: string | undefined, maxChars: number): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function boundObservationInput(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_OBSERVATION_INPUT_CHARS
    ? trimmed.slice(0, MAX_OBSERVATION_INPUT_CHARS)
    : trimmed;
}

function replaceRequestIdPreview(
  text: string | undefined,
  requestId: string | undefined,
): string | undefined {
  if (!text || !requestId) {
    return text;
  }
  return text.split(requestId).join(redactIdentifier(requestId, { len: 12 }));
}

function redactObservationText(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  // Observation logs must stay redacted even when operators disable general-purpose
  // log redaction, otherwise raw provider payloads leak back into always-on logs.
  const configuredPatterns = resolveConfiguredRedactPatterns();
  return redactSensitiveText(text, {
    mode: "tools",
    patterns: [
      ...getDefaultRedactPatterns(),
      ...configuredPatterns,
      ...OBSERVATION_EXTRA_REDACT_PATTERNS,
    ],
  });
}

function buildObservationFingerprint(params: {
  raw: string;
  requestId?: string;
  httpCode?: string;
  type?: string;
  message?: string;
}): string | null {
  const boundedMessage =
    params.message && params.message.length > MAX_FINGERPRINT_MESSAGE_CHARS
      ? params.message.slice(0, MAX_FINGERPRINT_MESSAGE_CHARS)
      : params.message;
  const structured =
    params.httpCode || params.type || boundedMessage
      ? stableStringify({
          httpCode: params.httpCode,
          type: params.type,
          message: boundedMessage,
        })
      : null;
  if (structured) {
    return structured;
  }
  if (params.requestId) {
    return params.raw.split(params.requestId).join("<request_id>");
  }
  return getApiErrorPayloadFingerprint(params.raw);
}

export function buildApiErrorObservationFields(
  rawError?: string,
  opts?: { provider?: string },
): {
  rawErrorPreview?: string;
  rawErrorHash?: string;
  rawErrorFingerprint?: string;
  httpCode?: string;
  providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const trimmed = boundObservationInput(rawError);
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = parseApiErrorInfo(trimmed);
    const requestId =
      parsed?.requestId ?? normalizeOptionalString(trimmed.match(REQUEST_ID_RE)?.[1]);
    const requestIdHash = requestId ? redactIdentifier(requestId, { len: 12 }) : undefined;
    const rawFingerprint = buildObservationFingerprint({
      raw: trimmed,
      requestId,
      httpCode: parsed?.httpCode,
      type: parsed?.type,
      message: parsed?.message,
    });
    const redactedRawPreview = replaceRequestIdPreview(redactObservationText(trimmed), requestId);
    const redactedProviderMessage = replaceRequestIdPreview(
      redactObservationText(parsed?.message),
      requestId,
    );

    return {
      rawErrorPreview: truncateForObservation(redactedRawPreview, RAW_ERROR_PREVIEW_MAX_CHARS),
      rawErrorHash: redactIdentifier(trimmed, { len: 12 }),
      rawErrorFingerprint: rawFingerprint
        ? redactIdentifier(rawFingerprint, { len: 12 })
        : undefined,
      httpCode: parsed?.httpCode,
      providerRuntimeFailureKind: classifyProviderRuntimeFailureKind({
        status: parsed?.httpCode ? Number(parsed.httpCode) : undefined,
        message: trimmed,
        provider: opts?.provider,
      }),
      providerErrorType: parsed?.type,
      providerErrorMessagePreview: truncateForObservation(
        redactedProviderMessage,
        PROVIDER_ERROR_PREVIEW_MAX_CHARS,
      ),
      requestIdHash,
    };
  } catch {
    return {};
  }
}

export function buildTextObservationFields(
  text?: string,
  opts?: { provider?: string },
): {
  textPreview?: string;
  textHash?: string;
  textFingerprint?: string;
  httpCode?: string;
  providerRuntimeFailureKind?: ProviderRuntimeFailureKind;
  providerErrorType?: string;
  providerErrorMessagePreview?: string;
  requestIdHash?: string;
} {
  const observed = buildApiErrorObservationFields(text, opts);
  return {
    textPreview: observed.rawErrorPreview,
    textHash: observed.rawErrorHash,
    textFingerprint: observed.rawErrorFingerprint,
    httpCode: observed.httpCode,
    providerRuntimeFailureKind: observed.providerRuntimeFailureKind,
    providerErrorType: observed.providerErrorType,
    providerErrorMessagePreview: observed.providerErrorMessagePreview,
    requestIdHash: observed.requestIdHash,
  };
}
