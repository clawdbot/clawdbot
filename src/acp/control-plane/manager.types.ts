/** Shared types and dependency wiring for the ACP session manager control plane. */
import type {
  AcpElicitationHandler,
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
} from "@openclaw/acp-core/runtime/types";
import type {
  SessionAcpIdentity,
  AcpSessionRuntimeOptions,
  SessionAcpMeta,
  SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AcpRuntimeError } from "../runtime/errors.js";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../runtime/registry.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";

export type AcpSessionTarget = { agentId: string; sessionKey: string };

/** Result of resolving persisted ACP metadata for a session key. */
export type AcpSessionResolution =
  | {
      kind: "none";
      sessionKey: string;
      agentId?: string;
    }
  | {
      kind: "stale";
      sessionKey: string;
      agentId: string;
      error: AcpRuntimeError;
    }
  | {
      kind: "ready";
      sessionKey: string;
      agentId: string;
      meta: SessionAcpMeta;
      entry?: SessionEntry;
    };

/** Input required to create or resume an ACP runtime session. */
export type AcpInitializeSessionInput = {
  /** Ephemeral source authority; rechecked after queued work and before publication. */
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  runtimeOptions?: Partial<AcpSessionRuntimeOptions>;
  modelExplicit?: boolean;
  cwd?: string;
  backendId?: string;
};

export type AcpTurnAttachment = AcpRuntimeTurnAttachment;

/** Input for one ACP prompt turn routed through the manager. */
export type AcpRunTurnInput = {
  /** Private admitted execution context supplied by the owning host ingress. */
  admittedRunContext: import("../../agents/admitted-run-context.js").AdmittedRunContext;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  provenance: "human" | "agent" | "system";
  text: string;
  attachments?: AcpTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
  onElicitation?: AcpElicitationHandler;
  /** Throwable host admission fence immediately before runtime prompt submission. */
  onBeforePrompt?: () => Promise<void> | void;
  onLifecycle?: (event: AcpTurnLifecycleEvent) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
};

type AcpTurnLifecycleEvent = {
  type: "prompt_submitted";
  at: number;
};

/** Input for closing, resetting, or cleaning up an ACP session. */
export type AcpCloseSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: string;
  discardPersistentState?: boolean;
  clearMeta?: boolean;
  allowBackendUnavailable?: boolean;
  requireAcpSession?: boolean;
};

export type AcpCloseSessionResult = {
  runtimeClosed: boolean;
  runtimeNotice?: string;
  metaCleared: boolean;
};

/** User-facing session status assembled from persisted metadata and runtime status. */
export type AcpSessionStatus = {
  sessionKey: string;
  agentId?: string;
  backend: string;
  agent: string;
  identity?: SessionAcpIdentity;
  state: SessionAcpMeta["state"];
  mode: AcpRuntimeSessionMode;
  runtimeOptions: AcpSessionRuntimeOptions;
  capabilities: AcpRuntimeCapabilities;
  runtimeStatus?: AcpRuntimeStatus;
  lastActivityAt: number;
  lastError?: string;
};

/** Process-local ACP manager counters exposed for diagnostics. */
export type AcpManagerObservabilitySnapshot = {
  runtimeCache: {
    activeSessions: number;
    idleTtlMs: number;
    evictedTotal: number;
    lastEvictedAt?: number;
  };
  turns: {
    active: number;
    queueDepth: number;
    completed: number;
    failed: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
  };
  errorsByCode: Record<string, number>;
};

export type AcpStartupIdentityReconcileResult = {
  checked: number;
  resolved: number;
  failed: number;
};

export type ActiveTurnState = {
  requestId: string;
  instanceId: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  abortController: AbortController;
  cancelPromise?: Promise<void>;
};

export type TurnLatencyStats = {
  completed: number;
  failed: number;
  totalMs: number;
  maxMs: number;
};

export type AcpSessionManagerDeps = {
  listAcpSessions: typeof listAcpSessionEntries;
  loadSessionEntry: typeof readAcpSessionEntry;
  upsertSessionMeta: typeof upsertAcpSessionMeta;
  getRuntimeBackend: typeof getAcpRuntimeBackend;
  requireRuntimeBackend: typeof requireAcpRuntimeBackend;
};

export type WriteManagerSessionMeta = (params: {
  assertCommitAllowed?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
  failOnError?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}) => Promise<SessionEntry | null>;

export type ResolveManagerSession = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}) => AcpSessionResolution;

export type EnsureManagerRuntimeHandle = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  meta: SessionAcpMeta;
  selectedBackend?: string;
}) => Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }>;

export type ReconcileManagerRuntimeSessionIdentifiers = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
  failOnStatusError: boolean;
}) => Promise<{
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
}>;

export type SetManagerSessionState = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  state: SessionAcpMeta["state"];
  lastError?: string;
  clearLastError?: boolean;
}) => Promise<void>;

export type WithManagerSessionActor = <T>(
  target: AcpSessionTarget,
  op: () => Promise<T>,
) => Promise<T>;

export const DEFAULT_DEPS: AcpSessionManagerDeps = {
  listAcpSessions: listAcpSessionEntries,
  loadSessionEntry: readAcpSessionEntry,
  upsertSessionMeta: upsertAcpSessionMeta,
  getRuntimeBackend: getAcpRuntimeBackend,
  requireRuntimeBackend: requireAcpRuntimeBackend,
};

export type { AcpSessionRuntimeOptions, SessionAcpMeta, SessionEntry };
