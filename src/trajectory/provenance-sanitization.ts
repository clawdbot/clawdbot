import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../infra/crypto-digest.js";

const PERSISTED_TRAJECTORY_ORIGIN_KINDS = new Set([
  "external_user",
  "inter_session",
  "internal_system",
]);
const SOURCE_SESSION_HASH_DOMAIN = "openclaw:trajectory:source-session-key:v1";
const ORIGIN_SESSION_HASH_DOMAIN = "openclaw:trajectory:origin-session-id:v1";
const CANONICAL_SESSION_HASH_RE = /^sha256:v1:[0-9a-f]{64}$/u;

type PersistedTrajectoryOrigin = {
  kind: "external_user" | "inter_session" | "internal_system";
  sourceSessionHash?: string;
  originSessionHash?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

function normalizeOriginKind(value: unknown): PersistedTrajectoryOrigin["kind"] | undefined {
  return typeof value === "string" && PERSISTED_TRAJECTORY_ORIGIN_KINDS.has(value)
    ? (value as PersistedTrajectoryOrigin["kind"])
    : undefined;
}

function pseudonymizeSessionIdentifier(domain: string, value: string): string {
  return `sha256:v1:${sha256Hex(JSON.stringify([domain, value]))}`;
}

function normalizeCanonicalSessionHash(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && CANONICAL_SESSION_HASH_RE.test(normalized) ? normalized : undefined;
}

function projectOriginBase(
  record: Record<string, unknown>,
  kind: PersistedTrajectoryOrigin["kind"],
): PersistedTrajectoryOrigin {
  const origin: PersistedTrajectoryOrigin = { kind };
  const sourceChannel = normalizeOptionalString(record.sourceChannel);
  const sourceTool = normalizeOptionalString(record.sourceTool);
  if (sourceChannel) {
    origin.sourceChannel = sourceChannel;
  }
  if (sourceTool) {
    origin.sourceTool = sourceTool;
  }
  return origin;
}

function sanitizeLiveTrajectoryOrigin(value: unknown): PersistedTrajectoryOrigin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeOriginKind(value.kind);
  if (!kind) {
    return undefined;
  }
  const origin = projectOriginBase(value, kind);
  const sourceSessionKey = normalizeOptionalString(value.sourceSessionKey);
  const originSessionId = normalizeOptionalString(value.originSessionId);
  if (sourceSessionKey) {
    origin.sourceSessionHash = pseudonymizeSessionIdentifier(
      SOURCE_SESSION_HASH_DOMAIN,
      sourceSessionKey,
    );
  }
  if (originSessionId) {
    origin.originSessionHash = pseudonymizeSessionIdentifier(
      ORIGIN_SESSION_HASH_DOMAIN,
      originSessionId,
    );
  }
  return origin;
}

function sanitizeExportTrajectoryOrigin(value: unknown): PersistedTrajectoryOrigin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeOriginKind(value.kind);
  if (!kind) {
    return undefined;
  }
  const origin = projectOriginBase(value, kind);
  const sourceSessionKey = normalizeOptionalString(value.sourceSessionKey);
  const originSessionId = normalizeOptionalString(value.originSessionId);
  const sourceSessionHash = sourceSessionKey
    ? pseudonymizeSessionIdentifier(SOURCE_SESSION_HASH_DOMAIN, sourceSessionKey)
    : normalizeCanonicalSessionHash(value.sourceSessionHash);
  const originSessionHash = originSessionId
    ? pseudonymizeSessionIdentifier(ORIGIN_SESSION_HASH_DOMAIN, originSessionId)
    : normalizeCanonicalSessionHash(value.originSessionHash);
  if (sourceSessionHash) {
    origin.sourceSessionHash = sourceSessionHash;
  }
  if (originSessionHash) {
    origin.originSessionHash = originSessionHash;
  }
  return origin;
}

function sanitizePromptSubmittedData(
  data: Record<string, unknown>,
  sanitizeOrigin: (value: unknown) => PersistedTrajectoryOrigin | undefined,
): Record<string, unknown> {
  const sanitized = { ...data };
  delete sanitized.origin;
  const origin = sanitizeOrigin(data.origin);
  if (origin) {
    sanitized.origin = origin;
  }
  return sanitized;
}

export function sanitizeLivePromptSubmittedData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizePromptSubmittedData(data, sanitizeLiveTrajectoryOrigin);
}

export function sanitizeExportPromptSubmittedData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizePromptSubmittedData(data, sanitizeExportTrajectoryOrigin);
}
