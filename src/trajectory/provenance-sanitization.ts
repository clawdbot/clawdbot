import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  projectDiagnosticPayload,
  type DiagnosticPayloadProjectionContext,
  type DiagnosticPayloadProjectionOptions,
  type DiagnosticPayloadProjectionPath,
  type DiagnosticPayloadProjectionReason,
} from "../agents/payload-redaction.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { isSensitiveFieldKey, redactSensitiveFieldValue } from "../logging/redact.js";
import {
  maskStructuredFieldValue,
  shouldRedactStructuredAuthorizationCode,
} from "../logging/structured-field-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const ORIGIN_KINDS = new Set(["external_user", "inter_session", "internal_system"]);
const SOURCE_SESSION_HASH_DOMAIN = "openclaw:trajectory:source-session-key:v1";
const ORIGIN_SESSION_HASH_DOMAIN = "openclaw:trajectory:origin-session-id:v1";
const CANONICAL_SESSION_HASH_RE = /^sha256:v1:[0-9a-f]{64}$/u;
const MESSAGE_ARRAY_KEYS = new Set(["messages", "messagesSnapshot"]);
const MAX_IDENTITY_CHARS = 4096;
const ROUTING_IDENTITY_FIELDS = new Set([
  "originsessionhash",
  "originsessionid",
  "sessionkey",
  "sourcesessionhash",
  "sourcesessionkey",
  "targetsessionhash",
  "targetsessionkey",
]);
const FINAL_PROMPT_MAX_BYTES = 4 * 1024;
const TRAJECTORY_LIMITS = {
  maxArrayItems: 64,
  maxDepth: 6,
  maxObjectKeys: 64,
  maxStringChars: 32_768,
};

type OriginKind = "external_user" | "inter_session" | "internal_system";
type PersistedOrigin = {
  kind: OriginKind;
  sourceSessionHash?: string;
  originSessionHash?: string;
  sourceChannel?: string;
  sourceTool?: string;
};
type Mode = "live" | "export";
type EventLike = { type: string; data?: Record<string, unknown> };
type TranscriptEntryLike = { type?: unknown; message?: unknown };
type Transforms = {
  transformKey?: (value: string) => string;
  transformString?: (value: string) => string;
};
type Scope =
  | { kind: "data"; type: string }
  | { kind: "diagnostic" }
  | { kind: "entry" }
  | { kind: "event"; type: string }
  | { kind: "value" };

function hashIdentifier(domain: string, value: string): string {
  return `sha256:v1:${sha256Hex(JSON.stringify([domain, value]))}`;
}

function normalizeKind(value: unknown): OriginKind | undefined {
  return typeof value === "string" && ORIGIN_KINDS.has(value) ? (value as OriginKind) : undefined;
}

function hashRawIdentifier(value: unknown, domain: string): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > MAX_IDENTITY_CHARS) {
    return undefined;
  }
  return hashIdentifier(domain, normalized);
}

function canonicalHash(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && CANONICAL_SESSION_HASH_RE.test(normalized) ? normalized : undefined;
}

function projectOrigin(value: unknown, mode: Mode): PersistedOrigin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeKind(value.kind);
  if (!kind) {
    return undefined;
  }
  const sourceSessionHash =
    hashRawIdentifier(value.sourceSessionKey, SOURCE_SESSION_HASH_DOMAIN) ??
    (mode === "export" ? canonicalHash(value.sourceSessionHash) : undefined);
  const originSessionHash =
    hashRawIdentifier(value.originSessionId, ORIGIN_SESSION_HASH_DOMAIN) ??
    (mode === "export" ? canonicalHash(value.originSessionHash) : undefined);
  const sourceChannel = normalizeOptionalString(value.sourceChannel);
  const sourceTool = normalizeOptionalString(value.sourceTool);
  return {
    kind,
    ...(sourceSessionHash ? { sourceSessionHash } : {}),
    ...(originSessionHash ? { originSessionHash } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(sourceTool ? { sourceTool } : {}),
  };
}

function trajectoryMarker(
  reason: DiagnosticPayloadProjectionReason,
  details: Record<string, number>,
): unknown {
  const names: Record<DiagnosticPayloadProjectionReason, string> = {
    "array-size": "trajectory-array-size-limit",
    "circular-reference": "trajectory-circular-reference",
    depth: "trajectory-depth-limit",
    "object-size": "trajectory-object-size-limit",
    "string-size": "trajectory-field-size-limit",
  };
  return { truncated: true, reason: names[reason], ...details };
}

function pathParts(path: DiagnosticPayloadProjectionPath | undefined): Array<number | string> {
  const parts: Array<number | string> = [];
  for (let current = path; current; current = current.parent) {
    parts.unshift(current.key);
  }
  return parts;
}

function fieldName(context: DiagnosticPayloadProjectionContext): string {
  return typeof context.path?.key === "string" ? context.path.key : "";
}

function fieldPath(context: DiagnosticPayloadProjectionContext): string[] {
  return pathParts(context.path).filter((part): part is string => typeof part === "string");
}

function nearestSensitiveFieldKey(context: DiagnosticPayloadProjectionContext): string | undefined {
  // Sensitive ancestry overrides leaf-specific exemptions such as diagnostic code paths.
  for (let current = context.path; current; current = current.parent) {
    if (typeof current.key === "string" && isSensitiveFieldKey(current.key)) {
      return current.key;
    }
  }
  return undefined;
}

function isOwnedProvenancePath(parts: Array<number | string>, scope: Scope): boolean {
  const directMessagePath =
    (scope.kind === "entry" &&
      parts.length === 2 &&
      parts[0] === "message" &&
      parts[1] === "provenance") ||
    (scope.kind === "event" &&
      parts.length === 3 &&
      parts[0] === "data" &&
      parts[1] === "message" &&
      parts[2] === "provenance") ||
    (scope.kind === "data" &&
      parts.length === 2 &&
      parts[0] === "message" &&
      parts[1] === "provenance");
  if (directMessagePath) {
    return true;
  }

  const offset = scope.kind === "event" ? 1 : 0;
  const arrayMessagePath =
    (scope.kind === "event" || scope.kind === "data") &&
    parts.length === offset + 3 &&
    (offset === 0 || parts[0] === "data") &&
    MESSAGE_ARRAY_KEYS.has(String(parts[offset])) &&
    typeof parts[offset + 1] === "number" &&
    parts[offset + 2] === "provenance";
  if (arrayMessagePath) {
    return true;
  }

  const prefix = scope.kind === "event" ? ["data"] : [];
  return (
    (scope.kind === "event" || scope.kind === "data") &&
    scope.type === "prompt.submitted" &&
    parts.length === prefix.length + 1 &&
    parts.at(-1) === "origin" &&
    prefix.every((part, index) => parts[index] === part)
  );
}

function isOwnedProvenanceRecord(
  context: DiagnosticPayloadProjectionContext,
  scope: Scope,
): boolean {
  const parts = pathParts(context.path);
  if (!isOwnedProvenancePath(parts, scope)) {
    return false;
  }
  if (parts.at(-1) === "origin") {
    return true;
  }
  return isRecord(context.parent) && context.parent.role === "user";
}

function isRoutingIdentityField(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return ROUTING_IDENTITY_FIELDS.has(normalized);
}

function isDiagnosticContext(context: DiagnosticPayloadProjectionContext, scope: Scope): boolean {
  if (scope.kind === "diagnostic" || scope.kind === "data" || scope.kind === "value") {
    return true;
  }
  const root = pathParts(context.path)[0];
  return (
    (scope.kind === "event" && root === "data") || (scope.kind === "entry" && root === "message")
  );
}

function childProjectionContext(
  context: DiagnosticPayloadProjectionContext,
  key: string,
  parent: Readonly<Record<string, unknown>>,
): DiagnosticPayloadProjectionContext {
  return {
    depth: context.depth + 1,
    parent,
    path: context.path ? { key, parent: context.path } : { key },
  };
}

function projectTrajectoryValue(
  value: unknown,
  scope: Scope,
  mode: Mode,
  transforms: Transforms = {},
): unknown {
  const options: DiagnosticPayloadProjectionOptions = {
    createMarker: trajectoryMarker,
    limits: {
      ...TRAJECTORY_LIMITS,
      maxDepth:
        scope.kind === "event" || scope.kind === "entry"
          ? TRAJECTORY_LIMITS.maxDepth + 2
          : TRAJECTORY_LIMITS.maxDepth,
    },
    omitField: (key, record, context) => {
      const childContext = childProjectionContext(context, key, record);
      if (isOwnedProvenanceRecord(childContext, scope) && !projectOrigin(record[key], mode)) {
        return true;
      }
      return (
        isRoutingIdentityField(key) &&
        isDiagnosticContext(context, scope) &&
        !(
          isOwnedProvenanceRecord(context, scope) &&
          (key === "sourceSessionHash" || key === "originSessionHash")
        )
      );
    },
    redactPrimitive: (entry, context) => {
      const sensitiveKey = nearestSensitiveFieldKey(context);
      const primitiveText = String(entry);
      const redacted = sensitiveKey
        ? redactSensitiveFieldValue(sensitiveKey, primitiveText)
        : shouldRedactStructuredAuthorizationCode(fieldName(context), fieldPath(context))
          ? maskStructuredFieldValue(primitiveText)
          : redactSensitiveFieldValue(fieldName(context), primitiveText);
      return redacted === primitiveText ? entry : "***";
    },
    redactString: (text, context) => {
      if (
        isOwnedProvenancePath(pathParts(context.path?.parent), scope) &&
        (fieldName(context) === "sourceSessionHash" || fieldName(context) === "originSessionHash")
      ) {
        return text;
      }
      return redactSensitiveFieldValue(
        nearestSensitiveFieldKey(context) ?? fieldName(context),
        text,
      );
    },
    transformKey: transforms.transformKey,
    transformRecord: (record, context) =>
      isOwnedProvenanceRecord(context, scope) ? (projectOrigin(record, mode) ?? record) : record,
    transformString: (text, context) => {
      const transformed = transforms.transformString?.(text) ?? text;
      return shouldRedactStructuredAuthorizationCode(fieldName(context), fieldPath(context))
        ? maskStructuredFieldValue(transformed)
        : transformed;
    },
  };
  return projectDiagnosticPayload(value, options);
}

function prepareFinalPrompt(data: Record<string, unknown>): Record<string, unknown> {
  const raw = data.finalPromptText;
  if (typeof raw !== "string") {
    return data;
  }
  const redacted = redactSensitiveFieldValue("", raw);
  if (Buffer.byteLength(redacted, "utf8") <= FINAL_PROMPT_MAX_BYTES) {
    return redacted === raw ? data : { ...data, finalPromptText: redacted };
  }
  return {
    ...data,
    finalPromptText: truncateUtf8Prefix(redacted, FINAL_PROMPT_MAX_BYTES),
    finalPromptTextOriginalLength: raw.length,
  };
}

export function projectTrajectoryDiagnosticValue(value: unknown): unknown {
  return projectTrajectoryValue(value, { kind: "diagnostic" }, "live");
}

/** Stateless persistence-boundary projection; each record is sanitized independently. */
export class TrajectoryProvenanceSanitizer {
  constructor(private readonly params: { mode: Mode }) {}

  sanitizeEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
    return projectTrajectoryValue(
      prepareFinalPrompt(data),
      {
        kind: "data",
        type,
      },
      this.params.mode,
    ) as Record<string, unknown>;
  }

  sanitizeExportSnapshot<
    TEvent extends EventLike,
    TEntry extends TranscriptEntryLike,
    THeader,
  >(params: {
    runtimeEvents: readonly TEvent[];
    branchEntries: readonly TEntry[];
    header: THeader;
    transformKey?: (value: string) => string;
    transformString?: (value: string) => string;
  }): { runtimeEvents: TEvent[]; branchEntries: TEntry[]; header: THeader } {
    this.requireExport();
    const transforms = {
      transformKey: params.transformKey,
      transformString: params.transformString,
    };
    return {
      runtimeEvents: params.runtimeEvents.map(
        (event) =>
          projectTrajectoryValue(
            event,
            { kind: "event", type: event.type },
            this.params.mode,
            transforms,
          ) as TEvent,
      ),
      branchEntries: params.branchEntries.map(
        (entry) =>
          projectTrajectoryValue(
            entry,
            entry.type === "message" ? { kind: "entry" } : { kind: "diagnostic" },
            this.params.mode,
            transforms,
          ) as TEntry,
      ),
      header: projectTrajectoryValue(
        params.header,
        { kind: "value" },
        this.params.mode,
        transforms,
      ) as THeader,
    };
  }

  sanitizeExportValue<T>(value: T, transforms: Transforms = {}): T {
    this.requireExport();
    return projectTrajectoryValue(value, { kind: "value" }, this.params.mode, transforms) as T;
  }

  private requireExport(): void {
    if (this.params.mode !== "export") {
      throw new Error("Trajectory provenance export sanitization requires export mode");
    }
  }
}
