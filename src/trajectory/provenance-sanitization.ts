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
import { redactSensitiveFieldValue } from "../logging/redact.js";
import {
  maskStructuredFieldValue,
  shouldRedactStructuredAuthorizationCode,
} from "../logging/structured-field-redaction.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const ORIGIN_KINDS = new Set(["external_user", "inter_session", "internal_system"]);
const SOURCE_SESSION_HASH_DOMAIN = "openclaw:trajectory:source-session-key:v1";
const ORIGIN_SESSION_HASH_DOMAIN = "openclaw:trajectory:origin-session-id:v1";
const PROVENANCE_TEXT_HASH_DOMAIN = "openclaw:trajectory:provenance-text:v1";
const CANONICAL_SESSION_HASH_RE = /^sha256:v1:[0-9a-f]{64}$/u;
const MESSAGE_ARRAY_KEYS = new Set(["messages", "messagesSnapshot"]);
const MIN_IDENTITY_CHARS = 8;
const MAX_IDENTITY_CHARS = 4096;
const MAX_IDENTITIES = 64;
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
type UnsafeReason = "count" | "long" | "short";
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

function normalizeKind(value: unknown): OriginKind | undefined {
  return typeof value === "string" && ORIGIN_KINDS.has(value) ? (value as OriginKind) : undefined;
}

function hashIdentifier(domain: string, value: string): string {
  return `sha256:v1:${sha256Hex(JSON.stringify([domain, value]))}`;
}

function canonicalHash(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && CANONICAL_SESSION_HASH_RE.test(normalized) ? normalized : undefined;
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

function fieldName(context: DiagnosticPayloadProjectionContext): string {
  return typeof context.path?.key === "string" ? context.path.key : "";
}

function fieldPath(context: DiagnosticPayloadProjectionContext): string[] {
  return pathParts(context.path).filter((part): part is string => typeof part === "string");
}

function redactPrimitiveAtPath(value: string, context: DiagnosticPayloadProjectionContext): string {
  const key = fieldName(context);
  return shouldRedactStructuredAuthorizationCode(key, fieldPath(context))
    ? maskStructuredFieldValue(value)
    : redactSensitiveFieldValue(key, value);
}

function projectTrajectoryValue(
  value: unknown,
  scope: Scope,
  options: DiagnosticPayloadProjectionOptions = {},
): unknown {
  return projectDiagnosticPayload(value, {
    ...options,
    createMarker: trajectoryMarker,
    limits: {
      ...TRAJECTORY_LIMITS,
      maxDepth:
        scope.kind === "event" || scope.kind === "entry"
          ? TRAJECTORY_LIMITS.maxDepth + 2
          : TRAJECTORY_LIMITS.maxDepth,
    },
    redactPrimitive: (entry, context) => {
      const primitiveText = String(entry);
      return redactPrimitiveAtPath(primitiveText, context) === primitiveText ? entry : "***";
    },
    redactString: (text, context) => redactSensitiveFieldValue(fieldName(context), text),
    transformString: (text, context) => {
      const transformed = options.transformString?.(text, context) ?? text;
      return shouldRedactStructuredAuthorizationCode(fieldName(context), fieldPath(context))
        ? maskStructuredFieldValue(transformed)
        : transformed;
    },
  });
}

function pathParts(path: DiagnosticPayloadProjectionPath | undefined): Array<number | string> {
  const parts: Array<number | string> = [];
  for (let current = path; current; current = current.parent) {
    parts.unshift(current.key);
  }
  return parts;
}

function isPromptOriginPath(parts: Array<number | string>, scope: Scope): boolean {
  const prefix = scope.kind === "event" ? ["data"] : [];
  return (
    (scope.kind === "event" || scope.kind === "data") &&
    scope.type === "prompt.submitted" &&
    parts.length === prefix.length + 1 &&
    parts.at(-1) === "origin" &&
    prefix.every((part, index) => parts[index] === part)
  );
}

function isUserProvenancePath(parts: Array<number | string>, scope: Scope): boolean {
  if (scope.kind === "entry") {
    return parts.length === 2 && parts[0] === "message" && parts[1] === "provenance";
  }
  const offset = scope.kind === "event" ? 1 : 0;
  return (
    (scope.kind === "event" || scope.kind === "data") &&
    parts.length === offset + 3 &&
    (offset === 0 || parts[0] === "data") &&
    MESSAGE_ARRAY_KEYS.has(String(parts[offset])) &&
    typeof parts[offset + 1] === "number" &&
    parts[offset + 2] === "provenance"
  );
}

function childPath(
  context: DiagnosticPayloadProjectionContext,
  key: string,
): DiagnosticPayloadProjectionPath {
  return context.path ? { key, parent: context.path } : { key };
}

function isSessionKeyField(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "sessionkey" || normalized === "sourcesessionkey";
}

function isDiagnosticContext(context: DiagnosticPayloadProjectionContext, scope: Scope): boolean {
  if (scope.kind === "diagnostic" || scope.kind === "data") {
    return true;
  }
  const root = pathParts(context.path)[0];
  return (
    (scope.kind === "event" && root === "data") || (scope.kind === "entry" && root === "message")
  );
}

export function projectTrajectoryDiagnosticValue(value: unknown): unknown {
  return projectTrajectoryValue(value, { kind: "diagnostic" }, { omitField: isSessionKeyField });
}

/**
 * Stateful persistence-boundary sanitizer. Identities are learned only from
 * owned provenance paths before one bounded projection creates persisted data.
 */
export class TrajectoryProvenanceSanitizer {
  private readonly identities = new Set<string>();
  private readonly replacements = new Map<string, string>();
  private pattern: RegExp | null | undefined;
  private unsafe?: UnsafeReason;

  constructor(private readonly params: { mode: Mode; inputProvenance?: unknown }) {
    this.learnProvenance(params.inputProvenance);
  }

  sanitizeEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
    this.learnEventData(type, data);
    if (this.unsafe) {
      return { redacted: true, reason: "trajectory-provenance-sanitization-limit" };
    }
    return this.project(this.prepareFinalPrompt(data), { kind: "data", type });
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
    for (const event of params.runtimeEvents) {
      if (event.data) {
        this.learnEventData(event.type, event.data);
      }
    }
    for (const entry of params.branchEntries) {
      this.learnTranscriptEntry(entry);
    }
    this.throwIfUnsafe();
    const transforms = {
      transformKey: params.transformKey,
      transformString: params.transformString,
    };
    return {
      runtimeEvents: params.runtimeEvents.map(
        (event) => this.project(event, { kind: "event", type: event.type }, transforms) as TEvent,
      ),
      branchEntries: params.branchEntries.map(
        (entry) =>
          this.project(
            entry,
            entry.type === "message" ? { kind: "entry" } : { kind: "diagnostic" },
            transforms,
          ) as TEntry,
      ),
      header: this.project(params.header, { kind: "value" }, transforms) as THeader,
    };
  }

  sanitizeExportValue<T>(value: T, transforms: Transforms = {}, eventType?: string): T {
    this.requireExport();
    this.throwIfUnsafe();
    return this.project(
      value,
      eventType ? { kind: "event", type: eventType } : { kind: "value" },
      transforms,
    ) as T;
  }

  private requireExport(): void {
    if (this.params.mode !== "export") {
      throw new Error("Trajectory provenance export sanitization requires export mode");
    }
  }

  private learnEventData(type: string, data: Record<string, unknown>): void {
    if (type === "prompt.submitted") {
      this.learnProvenance(data.origin);
    }
    for (const key of MESSAGE_ARRAY_KEYS) {
      const messages = data[key];
      if (!Array.isArray(messages)) {
        continue;
      }
      for (const message of messages) {
        if (isRecord(message) && message.role === "user") {
          this.learnProvenance(message.provenance);
        }
      }
    }
  }

  private learnTranscriptEntry(entry: TranscriptEntryLike): void {
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
      this.learnProvenance(entry.message.provenance);
    }
  }

  private learnProvenance(value: unknown): void {
    if (!isRecord(value) || !normalizeKind(value.kind)) {
      return;
    }
    this.learnIdentity(value.sourceSessionKey);
    this.learnIdentity(value.originSessionId);
  }

  private learnIdentity(value: unknown): void {
    const identity = normalizeOptionalString(value);
    if (!identity || this.identities.has(identity)) {
      return;
    }
    if (this.identities.size >= MAX_IDENTITIES) {
      this.unsafe ??= "count";
      return;
    }
    this.identities.add(identity);
    if (identity.length < MIN_IDENTITY_CHARS || identity.length > MAX_IDENTITY_CHARS) {
      this.unsafe ??= identity.length < MIN_IDENTITY_CHARS ? "short" : "long";
      return;
    }
    this.replacements.set(identity, hashIdentifier(PROVENANCE_TEXT_HASH_DOMAIN, identity));
    this.pattern = undefined;
  }

  private projectOrigin(value: unknown): PersistedOrigin | undefined {
    if (!isRecord(value)) {
      return undefined;
    }
    const kind = normalizeKind(value.kind);
    if (!kind) {
      return undefined;
    }
    const projectId = (rawValue: unknown, hashValue: unknown, domain: string) => {
      const raw = normalizeOptionalString(rawValue);
      return raw
        ? hashIdentifier(domain, raw)
        : this.params.mode === "export"
          ? canonicalHash(hashValue)
          : undefined;
    };
    const sourceSessionHash = projectId(
      value.sourceSessionKey,
      value.sourceSessionHash,
      SOURCE_SESSION_HASH_DOMAIN,
    );
    const originSessionHash = projectId(
      value.originSessionId,
      value.originSessionHash,
      ORIGIN_SESSION_HASH_DOMAIN,
    );
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

  private project<T>(value: T, scope: Scope, transforms: Transforms = {}): T {
    const chain = (external: ((value: string) => string) | undefined) =>
      this.replacements.size > 0 || external
        ? (text: string) => {
            const replaced = this.replaceIdentities(text);
            return external?.(replaced) ?? replaced;
          }
        : undefined;
    return projectTrajectoryValue(value, scope, {
      omitField: (key, record, context) => {
        if (isSessionKeyField(key) && isDiagnosticContext(context, scope)) {
          return true;
        }
        const path = childPath(context, key);
        return (
          (isPromptOriginPath(pathParts(path), scope) ||
            (record.role === "user" && isUserProvenancePath(pathParts(path), scope))) &&
          this.projectOrigin(record[key]) === undefined
        );
      },
      transformKey: chain(transforms.transformKey),
      transformRecord: (record, context) => {
        const parts = pathParts(context.path);
        if (
          isPromptOriginPath(parts, scope) ||
          (isRecord(context.parent) &&
            context.parent.role === "user" &&
            isUserProvenancePath(parts, scope))
        ) {
          return this.projectOrigin(record) ?? {};
        }
        return record;
      },
      transformString: chain(transforms.transformString),
    }) as T;
  }

  private prepareFinalPrompt(data: Record<string, unknown>): Record<string, unknown> {
    const raw = data.finalPromptText;
    if (typeof raw !== "string") {
      return data;
    }
    const projected = redactSensitiveFieldValue("", this.replaceIdentities(raw));
    if (Buffer.byteLength(projected, "utf8") > FINAL_PROMPT_MAX_BYTES) {
      return {
        ...data,
        finalPromptText: truncateUtf8Prefix(projected, FINAL_PROMPT_MAX_BYTES),
        finalPromptTextOriginalLength: raw.length,
      };
    }
    return projected === raw ? data : { ...data, finalPromptText: projected };
  }

  private replaceIdentities(value: string): string {
    if (this.replacements.size === 0) {
      return value;
    }
    if (this.pattern === undefined) {
      const identities = [...this.replacements.keys()].toSorted(
        (left, right) => right.length - left.length || left.localeCompare(right),
      );
      this.pattern = new RegExp(
        identities.map((identity) => identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
        "gu",
      );
    }
    return this.pattern
      ? value.replace(this.pattern, (match) => this.replacements.get(match) ?? match)
      : value;
  }

  private throwIfUnsafe(): void {
    if (!this.unsafe) {
      return;
    }
    const detail =
      this.unsafe === "count"
        ? `more than ${MAX_IDENTITIES} identities`
        : this.unsafe === "short"
          ? `an identity shorter than ${MIN_IDENTITY_CHARS} characters`
          : `an identity longer than ${MAX_IDENTITY_CHARS} characters`;
    throw new Error(`Trajectory export refused unsafe provenance input: ${detail}`);
  }
}
