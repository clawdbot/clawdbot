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
const PROVENANCE_TEXT_HASH_DOMAIN = "openclaw:trajectory:provenance-text:v1";
const CANONICAL_SESSION_HASH_RE = /^sha256:v1:[0-9a-f]{64}$/u;
const PROVENANCE_TEXT_MIN_CHARS = 8;
const PROVENANCE_TEXT_MAX_CHARS = 4096;
const PROVENANCE_IDENTITY_MAX_COUNT = 64;
const RECOGNIZED_MESSAGE_ARRAY_KEYS = ["messages", "messagesSnapshot"] as const;

type PersistedTrajectoryOrigin = {
  kind: "external_user" | "inter_session" | "internal_system";
  sourceSessionHash?: string;
  originSessionHash?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

type TrajectoryProvenanceSanitizerMode = "live" | "export";
type UnsafeProvenanceReason = "identity-count-limit" | "identity-length-limit";

type TrajectoryEventLike = {
  type: string;
  data?: Record<string, unknown>;
};

type TrajectoryTranscriptEntryLike = {
  type?: unknown;
  message?: unknown;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compareReplacementIdentities(left: string, right: string): number {
  const byLength = right.length - left.length;
  if (byLength !== 0) {
    return byLength;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSanitizedObjectKey(key: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(key)) {
    usedKeys.add(key);
    return key;
  }
  let index = 2;
  while (usedKeys.has(`${key}#${index}`)) {
    index += 1;
  }
  const unique = `${key}#${index}`;
  usedKeys.add(unique);
  return unique;
}

function defineEnumerableValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Stateful persistence-boundary sanitizer. It learns routing identities only
 * from owned provenance paths, then scrubs their diagnostic echoes everywhere.
 */
export class TrajectoryProvenanceSanitizer {
  private readonly mode: TrajectoryProvenanceSanitizerMode;
  private readonly identities = new Set<string>();
  private readonly textReplacements = new Map<string, string>();
  private replacementPattern: RegExp | null | undefined;
  private unsafeReason: UnsafeProvenanceReason | undefined;

  constructor(params: { mode: TrajectoryProvenanceSanitizerMode; inputProvenance?: unknown }) {
    this.mode = params.mode;
    this.learnProvenance(params.inputProvenance);
  }

  sanitizeEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
    this.learnEventData(type, data);
    if (this.unsafeReason) {
      return this.handleUnsafeLiveData();
    }
    return this.cloneValue(this.prepareEventData(type, data));
  }

  sanitizeExportSnapshot<
    TEvent extends TrajectoryEventLike,
    TEntry extends TrajectoryTranscriptEntryLike,
    THeader,
  >(params: {
    runtimeEvents: readonly TEvent[];
    branchEntries: readonly TEntry[];
    header: THeader;
  }): {
    runtimeEvents: TEvent[];
    branchEntries: TEntry[];
    header: THeader;
  } {
    if (this.mode !== "export") {
      throw new Error("Trajectory provenance export sanitization requires export mode");
    }
    for (const event of params.runtimeEvents) {
      if (event.data) {
        this.learnEventData(event.type, event.data);
      }
    }
    for (const entry of params.branchEntries) {
      this.learnTranscriptEntry(entry);
    }
    this.throwIfUnsafeForExport();

    return {
      runtimeEvents: params.runtimeEvents.map((event) => this.cloneEvent(event)),
      branchEntries: params.branchEntries.map((entry) => this.cloneTranscriptEntry(entry)),
      header: this.cloneValue(params.header),
    };
  }

  private learnEventData(type: string, data: Record<string, unknown>): void {
    if (type === "prompt.submitted" && Object.hasOwn(data, "origin")) {
      this.learnProvenance(data.origin);
    }
    for (const key of RECOGNIZED_MESSAGE_ARRAY_KEYS) {
      const messages = data[key];
      if (!Array.isArray(messages)) {
        continue;
      }
      for (const message of messages) {
        if (isRecord(message) && message.role === "user" && Object.hasOwn(message, "provenance")) {
          this.learnProvenance(message.provenance);
        }
      }
    }
  }

  private learnTranscriptEntry(entry: TrajectoryTranscriptEntryLike): void {
    if (
      entry.type !== "message" ||
      !isRecord(entry.message) ||
      entry.message.role !== "user" ||
      !Object.hasOwn(entry.message, "provenance")
    ) {
      return;
    }
    this.learnProvenance(entry.message.provenance);
  }

  private learnProvenance(value: unknown): void {
    if (!isRecord(value) || !normalizeOriginKind(value.kind)) {
      return;
    }
    this.learnIdentity(value.sourceSessionKey);
    this.learnIdentity(value.originSessionId);
  }

  private learnIdentity(value: unknown): void {
    const normalized = normalizeOptionalString(value);
    if (
      !normalized ||
      CANONICAL_SESSION_HASH_RE.test(normalized) ||
      this.identities.has(normalized)
    ) {
      return;
    }
    if (this.identities.size >= PROVENANCE_IDENTITY_MAX_COUNT) {
      this.unsafeReason ??= "identity-count-limit";
      return;
    }
    this.identities.add(normalized);
    if (normalized.length > PROVENANCE_TEXT_MAX_CHARS) {
      this.unsafeReason ??= "identity-length-limit";
      return;
    }
    if (normalized.length < PROVENANCE_TEXT_MIN_CHARS) {
      return;
    }
    this.textReplacements.set(
      normalized,
      pseudonymizeSessionIdentifier(PROVENANCE_TEXT_HASH_DOMAIN, normalized),
    );
    this.replacementPattern = undefined;
  }

  private projectOrigin(value: unknown): PersistedTrajectoryOrigin | undefined {
    if (!isRecord(value)) {
      return undefined;
    }
    const kind = normalizeOriginKind(value.kind);
    if (!kind) {
      return undefined;
    }
    const origin: PersistedTrajectoryOrigin = { kind };
    const sourceSessionHash = this.projectStructuredIdentifier(
      value.sourceSessionKey,
      value.sourceSessionHash,
      SOURCE_SESSION_HASH_DOMAIN,
    );
    const originSessionHash = this.projectStructuredIdentifier(
      value.originSessionId,
      value.originSessionHash,
      ORIGIN_SESSION_HASH_DOMAIN,
    );
    const sourceChannel = normalizeOptionalString(value.sourceChannel);
    const sourceTool = normalizeOptionalString(value.sourceTool);
    if (sourceSessionHash) {
      origin.sourceSessionHash = sourceSessionHash;
    }
    if (originSessionHash) {
      origin.originSessionHash = originSessionHash;
    }
    if (sourceChannel) {
      origin.sourceChannel = sourceChannel;
    }
    if (sourceTool) {
      origin.sourceTool = sourceTool;
    }
    return origin;
  }

  private projectStructuredIdentifier(
    rawValue: unknown,
    hashValue: unknown,
    domain: string,
  ): string | undefined {
    const raw = normalizeOptionalString(rawValue);
    if (raw) {
      return normalizeCanonicalSessionHash(raw) ?? pseudonymizeSessionIdentifier(domain, raw);
    }
    return this.mode === "export" ? normalizeCanonicalSessionHash(hashValue) : undefined;
  }

  private prepareEventData(type: string, data: Record<string, unknown>): Record<string, unknown> {
    const prepared = { ...data };
    if (type === "prompt.submitted" && Object.hasOwn(data, "origin")) {
      delete prepared.origin;
      const origin = this.projectOrigin(data.origin);
      if (origin) {
        prepared.origin = origin;
      }
    }
    for (const key of RECOGNIZED_MESSAGE_ARRAY_KEYS) {
      const messages = data[key];
      if (Array.isArray(messages)) {
        prepared[key] = messages.map((message) => this.prepareUserMessage(message));
      }
    }
    return prepared;
  }

  private prepareUserMessage(value: unknown): unknown {
    if (!isRecord(value) || value.role !== "user" || !Object.hasOwn(value, "provenance")) {
      return value;
    }
    const prepared = { ...value };
    delete prepared.provenance;
    const provenance = this.projectOrigin(value.provenance);
    if (provenance) {
      prepared.provenance = provenance;
    }
    return prepared;
  }

  private cloneEvent<TEvent extends TrajectoryEventLike>(event: TEvent): TEvent {
    const prepared = {
      ...event,
      ...(event.data ? { data: this.prepareEventData(event.type, event.data) } : {}),
    };
    return this.cloneValue(prepared) as TEvent;
  }

  private cloneTranscriptEntry<TEntry extends TrajectoryTranscriptEntryLike>(
    entry: TEntry,
  ): TEntry {
    const prepared =
      entry.type === "message" && isRecord(entry.message)
        ? { ...entry, message: this.prepareUserMessage(entry.message) }
        : entry;
    return this.cloneValue(prepared) as TEntry;
  }

  private cloneValue<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
    if (typeof value === "string") {
      return this.replaceIdentityText(value) as T;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const existing = seen.get(value);
    if (existing !== undefined) {
      return existing as T;
    }
    if (Array.isArray(value)) {
      const cloned: unknown[] = [];
      seen.set(value, cloned);
      for (const entry of value) {
        cloned.push(this.cloneValue(entry, seen));
      }
      return cloned as T;
    }
    const cloned: Record<string, unknown> = {};
    seen.set(value, cloned);
    const usedKeys = new Set<string>();
    for (const [key, entry] of Object.entries(value)) {
      const sanitizedKey = uniqueSanitizedObjectKey(this.replaceIdentityText(key), usedKeys);
      defineEnumerableValue(cloned, sanitizedKey, this.cloneValue(entry, seen));
    }
    return cloned as T;
  }

  private replaceIdentityText(value: string): string {
    if (CANONICAL_SESSION_HASH_RE.test(value) || this.textReplacements.size === 0) {
      return value;
    }
    const pattern = this.resolveReplacementPattern();
    return pattern
      ? value.replace(pattern, (match) => this.textReplacements.get(match) ?? match)
      : value;
  }

  private resolveReplacementPattern(): RegExp | null {
    if (this.replacementPattern !== undefined) {
      return this.replacementPattern;
    }
    const identities = [...this.textReplacements.keys()].toSorted(compareReplacementIdentities);
    this.replacementPattern =
      identities.length > 0
        ? new RegExp(identities.map((identity) => escapeRegExp(identity)).join("|"), "gu")
        : null;
    return this.replacementPattern;
  }

  private handleUnsafeLiveData(): Record<string, unknown> {
    if (this.mode === "export") {
      this.throwIfUnsafeForExport();
    }
    return {
      redacted: true,
      reason: "trajectory-provenance-sanitization-limit",
    };
  }

  private throwIfUnsafeForExport(): void {
    if (!this.unsafeReason) {
      return;
    }
    const detail =
      this.unsafeReason === "identity-count-limit"
        ? `more than ${PROVENANCE_IDENTITY_MAX_COUNT} identities`
        : `an identity longer than ${PROVENANCE_TEXT_MAX_CHARS} characters`;
    throw new Error(`Trajectory export refused unsafe provenance input: ${detail}`);
  }
}
