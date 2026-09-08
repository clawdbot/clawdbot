import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const SUBAGENT_ROLES = ["orchestrator", "leaf"] as const;
const SUBAGENT_CONTROL_SCOPES = ["children", "none"] as const;

type SubagentRole = (typeof SUBAGENT_ROLES)[number];
type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

export type AcpSessionLineageMeta = {
  /** Stable session key emitted to ACP clients. */
  sessionKey: string;
  kind?: string;
  channel?: string;
  /** Best available parent session id, preferring explicit parentSessionKey over legacy spawnedBy. */
  parentSessionId?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: SubagentRole;
  subagentControlScope?: SubagentControlScope;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};

export type AcpSessionLineageRow = {
  /** Raw persisted session key; kept even when other optional fields are malformed. */
  key: string;
  kind?: string;
  channel?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  spawnDepth?: number;
  subagentRole?: string;
  subagentControlScope?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
};

function readInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = normalizeOptionalString(value);
  return allowed.find((candidate) => candidate === normalized);
}

/** Converts persisted session rows into compact ACP lineage metadata for protocol responses. */
export function toAcpSessionLineageMeta(row: AcpSessionLineageRow): AcpSessionLineageMeta {
  const sessionKey = normalizeOptionalString(row.key) ?? row.key;
  const kind = normalizeOptionalString(row.kind);
  const channel = normalizeOptionalString(row.channel);
  // Older rows may only carry spawnedBy; expose it as parentSessionId so ACP clients
  // can follow lineage without knowing which storage-era field populated it.
  const parentSessionId =
    normalizeOptionalString(row.parentSessionKey) ?? normalizeOptionalString(row.spawnedBy);
  const spawnedBy = normalizeOptionalString(row.spawnedBy);
  const spawnDepth = readInteger(row.spawnDepth);
  const subagentRole = readEnum(row.subagentRole, SUBAGENT_ROLES);
  const subagentControlScope = readEnum(row.subagentControlScope, SUBAGENT_CONTROL_SCOPES);
  const spawnedWorkspaceDir = normalizeOptionalString(row.spawnedWorkspaceDir);
  const spawnedCwd = normalizeOptionalString(row.spawnedCwd);

  return {
    sessionKey,
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(spawnedBy ? { spawnedBy } : {}),
    ...(spawnDepth !== undefined ? { spawnDepth } : {}),
    ...(subagentRole ? { subagentRole } : {}),
    ...(subagentControlScope ? { subagentControlScope } : {}),
    ...(spawnedWorkspaceDir ? { spawnedWorkspaceDir } : {}),
    ...(spawnedCwd ? { spawnedCwd } : {}),
  };
}
