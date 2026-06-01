import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
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

export type AcpSessionResolution =
  | {
      kind: "none";
      sessionKey: string;
    }
  | {
      kind: "stale";
      sessionKey: string;
      error: AcpRuntimeError;
    }
  | {
      kind: "ready";
      sessionKey: string;
      meta: SessionAcpMeta;
    };

export type AcpInitializeSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  runtimeOptions?: Partial<AcpSessionRuntimeOptions>;
  cwd?: string;
  backendId?: string;
};

export type AcpTurnAttachment = {
  mediaType: string;
  data: string;
};

export type AcpRunTurnInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  text: string;
  attachments?: AcpTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
  onLifecycle?: (event: AcpTurnLifecycleEvent) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
};

export type AcpTurnLifecycleEvent = {
  type: "prompt_submitted";
  at: number;
};

export type AcpCloseSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
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

export type AcpSessionStatus = {
  sessionKey: string;
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
  readSessionEntry: typeof readAcpSessionEntry;
  upsertSessionMeta: typeof upsertAcpSessionMeta;
  getRuntimeBackend: typeof getAcpRuntimeBackend;
  requireRuntimeBackend: typeof requireAcpRuntimeBackend;
};

export type WriteManagerSessionMeta = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
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
}) => AcpSessionResolution;

export type EnsureManagerRuntimeHandle = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  meta: SessionAcpMeta;
}) => Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }>;

export type ReconcileManagerRuntimeSessionIdentifiers = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
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
  state: SessionAcpMeta["state"];
  lastError?: string;
  clearLastError?: boolean;
}) => Promise<void>;

export type WithManagerSessionActor = <T>(sessionKey: string, op: () => Promise<T>) => Promise<T>;

export const DEFAULT_DEPS: AcpSessionManagerDeps = {
  listAcpSessions: listAcpSessionEntries,
  readSessionEntry: readAcpSessionEntry,
  upsertSessionMeta: upsertAcpSessionMeta,
  getRuntimeBackend: getAcpRuntimeBackend,
  requireRuntimeBackend: requireAcpRuntimeBackend,
};

export type { AcpSessionRuntimeOptions, SessionAcpMeta, SessionEntry };
