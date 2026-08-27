import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FollowupRun } from "./types.js";

function projectSessionPermissionMode(
  value: unknown,
): NonNullable<FollowupRun["run"]["permissionMode"]> | undefined {
  return value === "read-only" || value === "guarded" || value === "workspace" || value === "full"
    ? value
    : undefined;
}

export function projectSessionPermissionPair(run: {
  permissionMode?: unknown;
  sessionRoot?: unknown;
}):
  | {
      permissionMode: NonNullable<FollowupRun["run"]["permissionMode"]>;
      sessionRoot: string;
    }
  | undefined {
  const permissionMode = projectSessionPermissionMode(run.permissionMode);
  const sessionRoot = normalizeOptionalString(run.sessionRoot);
  return permissionMode && sessionRoot ? { permissionMode, sessionRoot } : undefined;
}

export function hasInvalidSessionPermissionPolicy(run: {
  permissionMode?: unknown;
  sessionRoot?: unknown;
}): boolean {
  return (
    (run.permissionMode !== undefined || run.sessionRoot !== undefined) &&
    projectSessionPermissionPair(run) === undefined
  );
}

export function projectInputProvenance(
  value: unknown,
): FollowupRun["run"]["inputProvenance"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind !== "external_user" && kind !== "inter_session" && kind !== "internal_system") {
    return undefined;
  }
  const sourceChannel = normalizeOptionalString(value.sourceChannel);
  const sourceTool = normalizeOptionalString(value.sourceTool);
  return {
    kind,
    ...(sourceChannel ? { sourceChannel } : {}),
    ...(sourceTool ? { sourceTool } : {}),
  };
}

export function hasInvalidInputProvenance(run: { inputProvenance?: unknown }): boolean {
  return (
    run.inputProvenance !== undefined && projectInputProvenance(run.inputProvenance) === undefined
  );
}

export function persistedInputProvenanceCarriesSourceIdentity(run: {
  inputProvenance?: unknown;
}): boolean {
  if (!isRecord(run.inputProvenance)) {
    return false;
  }
  return (
    normalizeOptionalString(run.inputProvenance.originSessionId) !== undefined ||
    normalizeOptionalString(run.inputProvenance.sourceSessionKey) !== undefined
  );
}

const RAW_CHANNEL_IDENTITY_KEYS = [
  "senderId",
  "senderName",
  "senderUsername",
  "senderE164",
  "channelContext",
] as const;

export function persistedRunCarriesRawChannelIdentity(run: object): boolean {
  // SAFETY: persisted run descriptors are JSON objects; we only read known identity keys.
  const record = run as Record<string, unknown>;
  return RAW_CHANNEL_IDENTITY_KEYS.some((key) => record[key] !== undefined);
}

export function persistedFollowupItemCarriesInboundContext(item: unknown): boolean {
  return isRecord(item) && item.currentInboundContext !== undefined;
}

export function projectCliSessionBindingFacts(
  facts: FollowupRun["run"]["cliSessionBindingFacts"],
): FollowupRun["run"]["cliSessionBindingFacts"] | undefined {
  if (!facts) {
    return undefined;
  }
  const projected: NonNullable<FollowupRun["run"]["cliSessionBindingFacts"]> = {};
  if (facts.sourceReplyDeliveryMode !== undefined) {
    projected.sourceReplyDeliveryMode = facts.sourceReplyDeliveryMode;
  }
  if (facts.requireExplicitMessageTarget !== undefined) {
    projected.requireExplicitMessageTarget = facts.requireExplicitMessageTarget;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Bounded retention window for durable queued content. Restore fail-closes
 * rows older than this instead of replaying stale user content (and letting
 * it linger in shared SQLite) after long downtime.
 */
const FOLLOWUP_QUEUE_MAX_RESTORE_AGE_MS = 48 * 60 * 60 * 1000;

export function isExpiredPersistedFollowup(
  item: { enqueuedAt?: unknown },
  now: number = Date.now(),
): boolean {
  const enqueuedAt = item.enqueuedAt;
  return (
    typeof enqueuedAt !== "number" ||
    !Number.isFinite(enqueuedAt) ||
    now - enqueuedAt > FOLLOWUP_QUEUE_MAX_RESTORE_AGE_MS
  );
}

/**
 * Inline image payloads are never written to shared SQLite. Persist marks the
 * item `inlineImagesElided` instead; restore fail-closes the marker (and any
 * legacy row that still carries raw `images`) rather than replaying a turn
 * whose image content was deliberately not retained.
 */
export function persistedFollowupCarriesInlineImagePayload(item: unknown): boolean {
  if (!isRecord(item)) {
    return false;
  }
  return item.inlineImagesElided === true || (Array.isArray(item.images) && item.images.length > 0);
}

const KNOWN_EXEC_OVERRIDE_KEYS = new Set(["host", "security", "ask", "node", "nodeCwd"]);

export function projectRestrictiveExecOverrides(
  value: unknown,
): NonNullable<FollowupRun["run"]["execOverrides"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const projected: NonNullable<FollowupRun["run"]["execOverrides"]> = {};
  if (value.security === "deny" || value.security === "allowlist") {
    projected.security = value.security;
  }
  if (value.ask === "always" || value.ask === "on-miss") {
    projected.ask = value.ask;
  }
  if (value.host === "sandbox") {
    projected.host = "sandbox";
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function hasInvalidRestrictiveExecOverrides(run: { execOverrides?: unknown }): boolean {
  if (run.execOverrides === undefined) {
    return false;
  }
  if (!isRecord(run.execOverrides)) {
    return true;
  }
  if (Object.keys(run.execOverrides).some((key) => !KNOWN_EXEC_OVERRIDE_KEYS.has(key))) {
    return true;
  }
  const security = run.execOverrides.security;
  const ask = run.execOverrides.ask;
  const host = run.execOverrides.host;
  if (
    security !== undefined &&
    security !== "deny" &&
    security !== "allowlist" &&
    security !== "full"
  ) {
    return true;
  }
  if (ask !== undefined && ask !== "off" && ask !== "on-miss" && ask !== "always") {
    return true;
  }
  if (host !== undefined && host !== "sandbox" && host !== "gateway" && host !== "node") {
    return true;
  }
  if (run.execOverrides.node !== undefined && typeof run.execOverrides.node !== "string") {
    return true;
  }
  if (run.execOverrides.nodeCwd !== undefined && typeof run.execOverrides.nodeCwd !== "string") {
    return true;
  }
  const hasRestrictiveIntent =
    security === "deny" ||
    security === "allowlist" ||
    ask === "always" ||
    ask === "on-miss" ||
    host === "sandbox";
  return hasRestrictiveIntent && projectRestrictiveExecOverrides(run.execOverrides) === undefined;
}
