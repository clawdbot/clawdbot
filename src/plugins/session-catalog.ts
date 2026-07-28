import { createHash } from "node:crypto";
import type {
  SessionCatalogHost,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";

export type SessionCatalogListProviderParams = {
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
export type SessionCatalogReadProviderParams = Omit<SessionsCatalogReadParams, "catalogId">;
export type SessionCatalogContinueProviderParams = Omit<
  SessionsCatalogContinueParams,
  "catalogId"
> & {
  /** Caller's gateway scopes so providers can gate high-authority continues up front. */
  clientScopes?: readonly string[];
};
export type SessionCatalogArchiveProviderParams = Omit<SessionsCatalogArchiveParams, "catalogId">;

export type SessionCatalogTerminalPlan =
  | {
      kind: "local";
      argv: string[];
      cwd?: string;
      title?: string;
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

export type SessionCatalogEntrySummary = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number];

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
  /** Resolves the current core new-session target for the requested agent. */
  resolveCreateSession?: (
    params: SessionCatalogCreateParams,
  ) => SessionCatalogCreateTarget | undefined;
  list: (params: SessionCatalogListProviderParams) => Promise<SessionCatalogHost[]>;
  read: (params: SessionCatalogReadProviderParams) => Promise<SessionsCatalogReadResult>;
  continueSession?: (
    params: SessionCatalogContinueProviderParams,
  ) => Promise<SessionCatalogContinueProviderResult>;
  checkUpstreamActivity?: (probes: SessionUpstreamProbe[]) => Promise<SessionUpstreamActivity[]>;
  archive?: (params: SessionCatalogArchiveProviderParams) => Promise<{ ok: true }>;
  openTerminal?: (request: {
    hostId: string;
    threadId: string;
  }) => Promise<SessionCatalogTerminalPlan>;
};

type SessionCatalogAdoptedSource = { hostId: string; threadId: string };
type SessionCatalogEntry = SessionCatalogEntrySummary["entry"];

export function listSessionCatalogEntries(params: {
  config: OpenClawConfig;
  runtime: PluginRuntime;
  sessionEntries?: SessionCatalogEntrySnapshot;
}): SessionCatalogAgentEntry[] {
  const requestEntries = params.sessionEntries?.entriesForCatalog?.();
  if (requestEntries) {
    // Keep the shipped SDK helper as the compatibility entry point while the
    // Gateway snapshot owns the one request-wide flatten.
    return requestEntries;
  }
  const defaultAgentId = resolveDefaultAgentId(params.config);
  const agentIds = [
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
    findExisting: () => string | undefined;
    create: () => Promise<{ sessionKey: string }>;
    complete: (continued: { sessionKey: string }) => Promise<TResult>;
  }): Promise<TResult> => {
    const pending = operations.get(params.sourceKey);
    if (pending) {
      return await pending;
    }
    const operation = (async () => {
      const existing = params.findExisting();
      if (existing) {
        // The gateway's same-source link upsert preserves its active marker. Re-running
        // completion only supplies a new baseline after that link was removed.
        return await params.complete({ sessionKey: existing });
      }
      const continued = await params.create().catch((error: unknown) => {
        const raced = params.findExisting();
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
