import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

const UPSTREAM_USER_TEXT_META_KEY = "upstreamUserText" as const;
const MIRROR_IDENTITY_META_KEY = "mirrorIdentity" as const;
const IMPORTED_HISTORY_META_KEY = "importedHistory" as const;

export function attachCodexMirrorIdentity<T extends AgentMessage>(message: T, identity: string): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [MIRROR_IDENTITY_META_KEY]: identity },
  } as unknown as T;
}

export function readMirrorIdentity(message: AgentMessage): string | undefined {
  const record = message as unknown as { __openclaw?: unknown };
  const meta = record["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)[MIRROR_IDENTITY_META_KEY];
  return typeof id === "string" && id ? id : undefined;
}

export function attachUpstreamUserText<T extends AgentMessage>(message: T, text: string): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [UPSTREAM_USER_TEXT_META_KEY]: text },
  } as unknown as T;
}

export function readUpstreamUserText(message: AgentMessage | undefined): string | undefined {
  const record = message as unknown as { __openclaw?: unknown } | undefined;
  const meta = record?.["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const text = (meta as Record<string, unknown>)[UPSTREAM_USER_TEXT_META_KEY];
  return typeof text === "string" && text ? text : undefined;
}

/** Mark a row written by bounded history import, whose text went through the import
 * projection (trim + per-message cap). Drift checks need this to know the stored text is
 * lossy; without it they must compare exactly, because a live row is not projected. */
export function attachImportedHistoryProvenance<T extends AgentMessage>(message: T): T {
  const record = message as unknown as Record<string, unknown>;
  const existing = record["__openclaw"];
  const baseMeta =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: { ...baseMeta, [IMPORTED_HISTORY_META_KEY]: true },
  } as unknown as T;
}

export function isImportedHistoryMessage(message: AgentMessage | undefined): boolean {
  const record = message as unknown as { __openclaw?: unknown } | undefined;
  const meta = record?.["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  return (meta as Record<string, unknown>)[IMPORTED_HISTORY_META_KEY] === true;
}
