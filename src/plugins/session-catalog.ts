import { createHash } from "node:crypto";
import type {
  SessionCatalogHost,
  SessionCatalogShareRoute,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { listAgentIds, resolveSessionAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";

export type SessionCatalogListProviderParams = {
  /** Gateway always supplies this; optional only for pre-existing external provider types. */
  agentId?: string;
  /** False when Gateway-local scans must not inherit a root from process HOME. */
  allowProcessHomeFallback?: boolean;
  /** Trimmed, non-empty search capped at 500 UTF-16 code units by the gateway. */
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
  /** Request-owned shared entries. Providers must not mutate or retain them past `list`. */
  sessionEntries?: SessionCatalogEntrySnapshot;
  /** Lazily lists Gateway nodes once per catalog request. Providers must not retain this past `list`. */
  listNodes?: () => ReturnType<PluginRuntime["nodes"]["list"]>;
  /** Publishes completed hosts without waiting for slower machines in the same list. */
  onHost?: (host: SessionCatalogHost) => void;
};
export type SessionCatalogReadProviderParams = Omit<SessionsCatalogReadParams, "catalogId"> & {
  /** Gateway always supplies this; optional only for pre-existing external provider types. */
  agentId?: string;
  /** False when Gateway-local reads must not inherit a root from process HOME. */
  allowProcessHomeFallback?: boolean;
};
export type SessionCatalogContinueProviderParams = Omit<
  SessionsCatalogContinueParams,
  "catalogId"
> & {
  /** Gateway always supplies this; optional only for pre-existing external provider types. */
  agentId?: string;
  /** False when Gateway-local continuation must not inherit a root from process HOME. */
  allowProcessHomeFallback?: boolean;
  /** Caller's gateway scopes so providers can gate high-authority continues up front. */
  clientScopes?: readonly string[];
};
export type SessionCatalogArchiveProviderParams = Omit<
  SessionsCatalogArchiveParams,
  "catalogId"
> & {
  /** Gateway always supplies this; optional only for pre-existing external provider types. */
  agentId?: string;
  /** False when Gateway-local archive must not inherit a root from process HOME. */
  allowProcessHomeFallback?: boolean;
};

export type SessionCatalogStartTerminalProviderParams = {
  /** False when Gateway-local terminal start must not inherit process HOME. */
  allowProcessHomeFallback?: boolean;
  agentId: string;
  cwd: string;
  initialMessage?: string;
  /** Present only when the caller selected a catalog host backed by this node. */
  nodeId?: string;
};

export type SessionCatalogTerminalPlan =
  | {
      kind: "local";
      argv: string[];
      cwd?: string;
      title?: string;
      /** Bounded command-specific environment overrides. */
      env?: Record<string, string>;
      /** PATH that resolved argv[0], needed by env-based script interpreters. */
      pathEnv?: string;
    }
  | {
      kind: "node";
      nodeId: string;
      command: string;
      paramsJSON: string;
      cwd?: string;
      title?: string;
    };

export type SessionCatalogCreateTarget = {
  model: string;
  /** Concrete runtime pinned onto the created session so config reloads cannot retarget it. */
  agentRuntime: string;
};

export interface SessionCatalogEntrySummary {
  sessionKey: string;
  entry: SessionEntry;
}

/** Shared, logically frozen store state for one request; copy locally before mutating. */
export type SessionCatalogEntrySnapshot = {
  entriesForAgent: (agentId: string) => readonly SessionCatalogEntrySummary[];
  /** Request-wide flatten; optional for compatibility with pre-flatten plugin hosts. */
  entriesForCatalog?: () => SessionCatalogAgentEntry[];
};

type SessionCatalogAgentEntry = SessionCatalogEntrySummary & { agentId: string };

export type SessionUpstreamJsonValue =
  | null
  | boolean
  | number
  | string
  | SessionUpstreamJsonValue[]
  | { [key: string]: SessionUpstreamJsonValue };

export type SessionUpstreamKind = "claude-cli" | "codex-app-server" | "opencode-cli" | "pi-cli";

export type SessionUpstreamProbe = {
  sessionKey: string;
  agentId: string;
  threadId: string;
  hostId: string;
  upstreamKind: SessionUpstreamKind;
  upstreamRef: SessionUpstreamJsonValue;
  marker: SessionUpstreamJsonValue | null;
  ownRecentUserTexts: string[];
};

export function normalizeUserText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function isExternalUserText(probe: SessionUpstreamProbe, text: string | undefined): boolean {
  const normalized = text === undefined ? "" : normalizeUserText(text);
  return !probe.ownRecentUserTexts.includes(normalized);
}

export type SessionUpstreamActivity =
  | {
      kind: "activity";
      sessionKey: string;
      humanTurns: number;
      nextMarker: SessionUpstreamJsonValue;
      occurredAt?: number;
      dedupeId?: string;
    }
  | { kind: "missing"; sessionKey: string };

export type SessionCatalogContinueProviderResult = {
  sessionKey: string;
  /** Plugin binding installed for this authenticated Control UI session. */
  conversationBinding?: {
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
  };
  /** Publishes provider state only after the requested binding is durable. */
  afterConversationBound?: () => Promise<void>;
  /** Upstream link seed so the monitor can detect direct external activity. */
  upstream?: {
    kind: SessionUpstreamKind;
    ref: SessionUpstreamJsonValue;
    marker: SessionUpstreamJsonValue;
  };
};

type SessionCatalogCreateParams = {
  /** Agent whose model/runtime policy must authorize the catalog target. */
  agentId?: string;
};

export type SessionCatalogProvider = {
  id: string;
  label: string;
  /** Optional plugin-owned pretty route backed by exact prefix search on one catalog host. */
  shareRoute?: SessionCatalogShareRoute;
  /** Declares that every HOME-sensitive action honors the host isolation policy. */
  supportsProcessHomeIsolation?: true;
  /** Config-derived target; the Gateway memoizes it for one runtime-config object identity. */
  resolveCreateSession?: (
    params: SessionCatalogCreateParams,
  ) => SessionCatalogCreateTarget | undefined;
  list: (params: SessionCatalogListProviderParams) => Promise<SessionCatalogHost[]>;
  read: (params: SessionCatalogReadProviderParams) => Promise<SessionsCatalogReadResult>;
  continueSession?: (
    params: SessionCatalogContinueProviderParams,
  ) => Promise<SessionCatalogContinueProviderResult>;
  checkUpstreamActivity?: (
    probes: SessionUpstreamProbe[],
    policy?: { allowProcessHomeFallback?: boolean },
  ) => Promise<SessionUpstreamActivity[]>;
  archive?: (params: SessionCatalogArchiveProviderParams) => Promise<{ ok: true }>;
  openTerminal?: (request: {
    allowProcessHomeFallback?: boolean;
    /** Gateway always supplies this; optional only for pre-existing external provider types. */
    agentId?: string;
    hostId: string;
    threadId: string;
  }) => Promise<SessionCatalogTerminalPlan>;
  startTerminalSession?: (
    request: SessionCatalogStartTerminalProviderParams,
  ) => Promise<SessionCatalogTerminalPlan>;
};

type SessionCatalogAdoptedSource = { hostId: string; threadId: string };
type SessionCatalogEntry = SessionCatalogEntrySummary["entry"];

export function listSessionCatalogEntries(params: {
  agentId?: string;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
}): SessionCatalogAgentEntry[] {
  const requiresExplicitOwner = params.config.agents?.ownership === "explicit";
  const requestedAgentId =
    params.agentId || requiresExplicitOwner
      ? resolveSessionAgentIds({
          config: params.config,
          agentId: params.agentId,
        }).sessionAgentId
      : undefined;
  const requestEntries = params.sessionEntries?.entriesForCatalog?.();
  if (requestEntries) {
    // Keep the shipped SDK helper as the compatibility entry point while the
    // Gateway snapshot owns the one request-wide flatten.
    return requiresExplicitOwner && requestedAgentId
      ? requestEntries.filter((entry) => entry.agentId === requestedAgentId)
      : requestEntries;
  }
  const defaultAgentId =
    requestedAgentId ?? resolveSessionAgentIds({ config: params.config }).defaultAgentId;
  const agentIds = requiresExplicitOwner
    ? [defaultAgentId]
    : [
        defaultAgentId,
        ...listAgentIds(params.config).filter((agentId) => agentId !== defaultAgentId),
      ];
  return agentIds.flatMap((agentId) => {
    const entries = params.sessionEntries
      ? params.sessionEntries.entriesForAgent(agentId)
      : params.runtime.agent.session.listSessionEntries({ agentId, readOnly: true });
    return entries.map((entry) => Object.assign({}, entry, { agentId }));
  });
}

export function sessionCatalogAdoptedSourceKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

export function sessionCatalogAdoptedSessionKey(prefix: string, source: string): string {
  return `${prefix}${createHash("sha256").update(source).digest("hex")}`;
}

export function listAdoptedSessionCatalogSessions(params: {
  agentId?: string;
  config: OpenClawConfig;
  pluginId: string;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
  sourceFromEntry: (entry: SessionCatalogEntry) => SessionCatalogAdoptedSource | undefined;
}): Map<string, string> {
  const adopted = new Map<string, string>();
  for (const { sessionKey, entry } of listSessionCatalogEntries(params)) {
    const source = params.sourceFromEntry(entry);
    if (source && entry.pluginOwnerId === params.pluginId && entry.initializationPending !== true) {
      adopted.set(sessionCatalogAdoptedSourceKey(source.hostId, source.threadId), sessionKey);
    }
  }
  return adopted;
}

// `complete` is intentionally required, not optional-with-fallback: adoption and its
// upstream baseline must share one single-flight operation, or concurrent continues
// race to baseline the same thread. This helper shipped in no release tag yet
// (added #113718), so no external plugin can depend on the older 3-field shape.
export function createSessionCatalogAdoptionCoordinator<TResult extends { sessionKey: string }>() {
  const operations = new Map<string, Promise<TResult>>();
  return async (params: {
    sourceKey: string;
    findExisting: () => string | undefined | Promise<string | undefined>;
    create: () => Promise<{ sessionKey: string }>;
    complete: (continued: { sessionKey: string }) => Promise<TResult>;
  }): Promise<TResult> => {
    const pending = operations.get(params.sourceKey);
    if (pending) {
      return await pending;
    }
    const operation = (async () => {
      const existing = await params.findExisting();
      if (existing) {
        // The gateway's same-source link upsert preserves its active marker. Re-running
        // completion only supplies a new baseline after that link was removed.
        return await params.complete({ sessionKey: existing });
      }
      const continued = await params.create().catch(async (error: unknown) => {
        const raced = await params.findExisting();
        if (raced) {
          return { sessionKey: raced };
        }
        throw error;
      });
      return await params.complete(continued);
    })();
    operations.set(params.sourceKey, operation);
    try {
      return await operation;
    } finally {
      if (operations.get(params.sourceKey) === operation) {
        operations.delete(params.sourceKey);
      }
    }
  };
}
