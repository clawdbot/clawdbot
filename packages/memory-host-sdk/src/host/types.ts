// Public memory host contracts shared by runtime, builtin search, and package consumers.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
export type MemorySource = "memory" | "sessions";

export type MemoryOriginClass = "owner" | "agent" | "untrusted" | "system";

export type MemorySessionKind = "interactive" | "cron" | "heartbeat" | "subagent" | "unknown";

/** Additional memory root, optionally narrowed by a root-relative glob. */
export type MemoryExtraPath = string | { path: string; pattern?: string };

export type MemoryEntryProvenance = {
  originClass: MemoryOriginClass;
  sessionKind: MemorySessionKind;
  observedAt: number;
  supersedesKey?: string;
};

/** One ranked memory search hit with optional vector/text scoring details. */
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  importance?: number;
  triggers?: string;
  /** Semicolon-separated stable repository identities lifted from inline annotations. */
  projectKey?: string;
  /** @deprecated Use provenance.originClass. This field is not authoritative for automatic injection. */
  originClass?: string;
  citation?: string;
  provenance?: MemoryEntryProvenance;
};

/** Automatic prompt injection is reserved for content with authoritative trusted provenance. */
export function isMemoryOriginEligibleForAutomaticInjection(
  originClass: unknown,
): originClass is "owner" | "agent" {
  return originClass === "owner" || originClass === "agent";
}

export function isAutomaticMemoryEntryEligible(
  entry: Pick<MemorySearchResult, "provenance">,
): boolean {
  return isMemoryOriginEligibleForAutomaticInjection(entry.provenance?.originClass);
}

/** Cached/probed embedding availability status. */
export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

/** Progress event emitted during memory sync. */
export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemorySessionSyncTarget = {
  /** Owning OpenClaw agent. Omit only when the active manager scope already supplies it. */
  agentId?: string;
  /** Storage-neutral transcript/session identity. */
  sessionId: string;
  /** Optional visible session-store key for callers that already carry it. */
  sessionKey?: string;
};

export type MemorySyncParams = {
  reason?: string;
  force?: boolean;
  /** Storage-neutral session transcript targets to refresh. */
  sessions?: MemorySessionSyncTarget[];
  /** Archive/support transcript files to refresh without treating paths as active session identity. */
  archiveFiles?: string[];
  progress?: (update: MemorySyncProgressUpdate) => void;
};

export type MemorySearchRuntimeDebug = {
  backend: "builtin";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
  embeddingBootstrap?: {
    ok: false;
    provider: string;
    reason: string;
    degradedTo: "keyword-only";
  };
};

/** Successful memory-file excerpt, optionally paginated/truncated. */
type MemoryReadSuccessResult = {
  status: "ok";
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

/** An allowed memory path that does not exist. */
type MemoryReadNotFoundResult = {
  status: "not_found";
  text: "";
  path: string;
  truncated?: never;
  from?: never;
  lines?: never;
  nextFrom?: never;
};

export type MemoryReadResult = MemoryReadSuccessResult | MemoryReadNotFoundResult;

/** Pre-status result accepted only from registered memory managers during migration. */
export type LegacyMemoryReadResult = {
  status?: never;
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

/** Aggregated memory backend status for CLI/UI diagnostics. */
export type MemoryVectorIndexState =
  | { state: "empty" }
  | { state: "complete" }
  | { state: "incomplete" }
  | { state: "unverified" };

export type MemoryProviderStatus = {
  backend: "builtin";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  /** Process-local failure from the newest admitted sync without a newer successful sync. */
  lastSyncError?: string;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: MemoryExtraPath[];
  sources?: MemorySource[];
  sourceCounts?: Array<{
    source: MemorySource;
    files: number;
    chunks: number;
    /** Stored chunk text and JSON embedding bytes, excluding cache and index overhead. */
    chunkBytes?: number;
    eligible?: number | null;
    issues?: string[];
  }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    index?: MemoryVectorIndexState;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export type MemoryIndexIdentityOwner = "openclaw" | "configuration";

export type MemoryIndexIdentityDiagnostic = {
  reason: string;
  code: string;
  owner: MemoryIndexIdentityOwner;
};

export function resolveMemoryIndexIdentityDiagnostic(
  status: Pick<MemoryProviderStatus, "custom">,
): MemoryIndexIdentityDiagnostic | undefined {
  const identity = asNullableRecord(status.custom?.indexIdentity);
  if (identity?.status !== "mismatched" && identity?.status !== "missing") {
    return undefined;
  }
  const reason = typeof identity.reason === "string" ? identity.reason.trim() : "";
  const code = typeof identity.code === "string" ? identity.code.trim() : "";
  return {
    reason: reason || "memory index identity is missing or mismatched",
    code: code || identity.status,
    owner: identity.owner === "openclaw" ? "openclaw" : "configuration",
  };
}

export function resolveMemoryIndexIdentityReason(
  status: Pick<MemoryProviderStatus, "custom">,
): string | undefined {
  return resolveMemoryIndexIdentityDiagnostic(status)?.reason;
}

export function formatMemoryIndexIdentityReason(diagnostic: MemoryIndexIdentityDiagnostic): string {
  return `${diagnostic.reason} (owner: ${diagnostic.owner}, code: ${diagnostic.code})`;
}

export function formatMemoryIndexRebuildCommand(agentId?: string): string {
  return `openclaw memory status --index${agentId?.trim() ? ` --agent ${agentId.trim()}` : ""}`;
}

export function formatMemoryIndexRebuildDisclosure(provider?: string): string {
  return provider === "none"
    ? "Rebuilding uses keyword indexing only and does not call an embedding provider."
    : `Rebuilding may call the configured embedding provider${provider ? ` (${provider})` : ""} and can incur provider cost.`;
}

export function resolveMemorySearchStaleness(
  status: Pick<MemoryProviderStatus, "custom" | "lastSyncError" | "provider">,
  agentId?: string,
): { stale: true; warning: string; action: string } | null {
  const diagnostic = resolveMemoryIndexIdentityDiagnostic(status);
  const reason = diagnostic
    ? formatMemoryIndexIdentityReason(diagnostic)
    : status.lastSyncError?.trim();
  if (!reason) {
    return null;
  }
  return {
    stale: true,
    warning: `Memory index is stale: ${reason}. Search results may be incomplete.`,
    action: `Run: ${formatMemoryIndexRebuildCommand(agentId)}. ${formatMemoryIndexRebuildDisclosure(status.provider)}`,
  };
}

/** Search/read/sync/status contract implemented by memory managers. */
export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      /**
       * Keyword/FTS scoring only: skip query embedding and vector search.
       * For reply-path recall (trigger injection) that must not add a
       * network round-trip per inbound message.
       */
      lexicalOnly?: boolean;
      /** Active repository identities used only for project-aware ranking. */
      activeProjectKeys?: string[];
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      /** Optional caller cancellation; managers consume it where their runtime supports cancellation. */
      signal?: AbortSignal;
    },
  ): Promise<MemorySearchResult[]>;
  listTriggerCandidates?(opts?: {
    limit?: number;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]>;
  listCuratedProjectCandidates?(opts: {
    activeProjectKeys: string[];
    limit?: number;
  }): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: MemorySyncParams): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
