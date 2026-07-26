import { createHash } from "node:crypto";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
  SessionsCatalogArchiveParams,
  SessionsCatalogContinueParams,
  SessionsCatalogReadParams,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentMessage } from "../plugin-sdk/agent-core.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

const SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS = 200;
const SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT = 100;

export type SessionCatalogListProviderParams = {
  /** Trimmed, non-empty search capped at 500 UTF-16 code units by the gateway. */
  search?: string;
  limitPerHost?: number;
  hostIds?: string[];
  cursors?: Record<string, string>;
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
type SessionCatalogEntry = ReturnType<
  PluginRuntime["agent"]["session"]["listSessionEntries"]
>[number]["entry"];

export function sessionCatalogAdoptedSourceKey(hostId: string, threadId: string): string {
  return `${hostId}\0${threadId}`;
}

export function sessionCatalogAdoptedSessionKey(prefix: string, source: string): string {
  return `${prefix}${createHash("sha256").update(source).digest("hex")}`;
}

function importedSessionCatalogMessage(params: {
  catalogId: string;
  item: SessionCatalogTranscriptItem;
  fallbackTimestamp: number;
}): AgentMessage | undefined {
  const parsedTimestamp = params.item.timestamp ? Date.parse(params.item.timestamp) : Number.NaN;
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : params.fallbackTimestamp;
  const importedText = params.item.text?.trim();
  if (!importedText && params.item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported catalog transcript item]";
  if (params.item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated external prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: `${params.catalogId}-catalog-import` },
    } as AgentMessage;
  }
  const prefix =
    params.item.type === "reasoning"
      ? "Thinking\n\n"
      : params.item.type === "toolCall"
        ? "Tool call\n\n"
        : params.item.type === "toolResult"
          ? "Tool result\n\n"
          : params.item.type === "other"
            ? "Other\n\n"
            : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `${prefix}${text}` }],
    timestamp,
    api: "openai-responses",
    provider: params.catalogId,
    model: params.item.model ?? "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

function fitSessionCatalogItemToBytes(
  item: SessionCatalogTranscriptItem,
  maxBytes: number,
): SessionCatalogTranscriptItem | undefined {
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= maxBytes) {
    return item;
  }
  const text = item.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const candidate = (length: number): SessionCatalogTranscriptItem => {
    const safeLength =
      length > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(length - 1)) ? length - 1 : length;
    return { ...item, text: `${text.slice(0, safeLength)}…`, truncated: true };
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(middle)), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const bounded = candidate(low);
  return Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes ? bounded : undefined;
}

function importableSessionCatalogItem(
  item: SessionCatalogTranscriptItem,
): SessionCatalogTranscriptItem {
  const { raw: _raw, ...importable } = item;
  return importable;
}

async function readBoundedSessionCatalogHistory(params: {
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
}): Promise<SessionCatalogTranscriptItem[]> {
  const pages: SessionCatalogTranscriptItem[][] = [];
  let cursor: string | undefined;
  let itemCount = 0;
  let bytes = 0;
  while (itemCount < SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS) {
    const page = await params.read({
      limit: Math.min(
        SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT,
        SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS - itemCount,
      ),
      ...(cursor ? { cursor } : {}),
    });
    const retained: SessionCatalogTranscriptItem[] = [];
    // Catalog pages move newest-to-oldest while each page stays chronological.
    // Walk backward for recent-window bounds, then prepend older retained pages.
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const item = page.items[index];
      if (!item) {
        continue;
      }
      const importableItem = importableSessionCatalogItem(item);
      const itemBytes = Buffer.byteLength(JSON.stringify(importableItem), "utf8");
      const remainingBytes = SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES - bytes;
      if (itemCount > 0 && itemBytes > remainingBytes) {
        return [retained, ...pages.toReversed()].flat();
      }
      const retainedItem =
        itemBytes <= remainingBytes
          ? importableItem
          : fitSessionCatalogItemToBytes(importableItem, remainingBytes);
      if (!retainedItem) {
        continue;
      }
      const retainedItemBytes = Buffer.byteLength(JSON.stringify(retainedItem), "utf8");
      retained.unshift(retainedItem);
      itemCount += 1;
      bytes += retainedItemBytes;
      if (
        itemCount === SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS ||
        bytes === SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES
      ) {
        return [retained, ...pages.toReversed()].flat();
      }
    }
    pages.push(retained);
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return pages.toReversed().flat();
}

export async function importSessionCatalogHistory(params: {
  catalogId: string;
  threadId: string;
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = await readBoundedSessionCatalogHistory({ read: params.read });
  const fallbackTimestamp = Date.now();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedSessionCatalogMessage({
        catalogId: params.catalogId,
        item,
        fallbackTimestamp: fallbackTimestamp + index,
      });
      if (!imported) {
        continue;
      }
      const message = {
        ...(imported as unknown as Record<string, unknown>),
        idempotencyKey: `${params.catalogId}-catalog:${params.threadId}:${item.id ?? index}`,
      } as unknown as AgentMessage;
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}

export function listAdoptedSessionCatalogSessions(params: {
  config: OpenClawConfig;
  pluginId: string;
  runtime: PluginRuntime;
  sourceFromEntry: (entry: SessionCatalogEntry) => SessionCatalogAdoptedSource | undefined;
}): Map<string, string> {
  const defaultAgentId = resolveDefaultAgentId(params.config);
  const agentIds = [
    defaultAgentId,
    ...listAgentIds(params.config).filter((agentId) => agentId !== defaultAgentId),
  ];
  const adopted = new Map<string, string>();
  for (const { sessionKey, entry } of agentIds.flatMap((agentId) =>
    params.runtime.agent.session.listSessionEntries({ agentId, readOnly: true }),
  )) {
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
