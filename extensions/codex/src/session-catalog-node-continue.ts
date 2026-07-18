import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { CodexThread } from "./app-server/protocol.js";
import { withTimeout } from "./app-server/timeout.js";
import { createCodexCliNodeConversationBindingData } from "./conversation-binding-data.js";
import { CODEX_CLI_SESSION_RESUME_COMMAND } from "./node-cli-sessions.js";
import {
  adoptedSourceKey,
  continueOperations,
  createOrReuseNodeAdoptedSession,
  finalizeNodeAdoptedSession,
  findNodeAdoptedSessionEntry,
  lastTerminalTurnId,
  nodeSessionMarker,
  runSessionActionExclusive,
  type AdoptedSessionEntry,
  type CodexNodeHistory,
  type CodexSessionDisposition,
} from "./session-catalog-node-adoption.js";
import {
  catalogError,
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  filterCatalogPageByTitle,
  isInteractiveThreadSource,
  MAX_ACTION_CATALOG_PAGES,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  NODE_INVOKE_TIMEOUT_MS,
  parseCatalogPage,
  parseTranscriptPage,
  unwrapNodeInvokePayload,
} from "./session-catalog-parsing.js";
import type {
  CodexSessionCatalogHost,
  CodexSessionCatalogParams,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";

const CODEX_NODE_CONTINUE_COMMANDS = [
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
] as const;

// Catalog refresh is fail-soft: one unhealthy machine must not hold the whole sidebar.
// The node invoke keeps running so cold native discovery can warm the next poll.
const NODE_CATALOG_LIST_RESPONSE_TIMEOUT_MS = 8_000;

export type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];

export function nodeLabel(node: CatalogNode): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

export function compareNodeLabels(left: CatalogNode, right: CatalogNode): number {
  const leftLabel = nodeLabel(left);
  const rightLabel = nodeLabel(right);
  if (leftLabel < rightLabel) {
    return -1;
  }
  if (leftLabel > rightLabel) {
    return 1;
  }
  return 0;
}

function canContinueCodexOnNode(node: CatalogNode): boolean {
  return (
    node.connected === true &&
    CODEX_NODE_CONTINUE_COMMANDS.every(
      (command) =>
        node.commands?.includes(command) === true &&
        node.invocableCommands?.includes(command) === true,
    )
  );
}

export async function listPairedNode(params: {
  runtime: PluginRuntime;
  node: CatalogNode;
  query: CodexSessionCatalogParams;
  adoptedSessions: ReadonlyMap<string, AdoptedSessionEntry>;
  onHost?: (host: CodexSessionCatalogHost) => void;
}): Promise<CodexSessionCatalogHost> {
  const hostId = `node:${params.node.nodeId}`;
  const common = {
    hostId,
    label: nodeLabel(params.node),
    kind: "node" as const,
    nodeId: params.node.nodeId,
    canContinueCodex: canContinueCodexOnNode(params.node),
  };
  if (params.node.connected !== true) {
    const host = {
      ...common,
      connected: false,
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    };
    params.onHost?.(host);
    return host;
  }
  const eventualHost = Promise.resolve()
    .then(async () => {
      const raw = await params.runtime.nodes.invoke({
        nodeId: params.node.nodeId,
        command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        params: {
          cursor: params.query.cursors?.[hostId],
          limit: params.query.limitPerHost,
          searchTerm: params.query.search,
        },
        timeoutMs: NODE_INVOKE_TIMEOUT_MS,
        scopes: ["operator.write"],
      });
      const page = filterCatalogPageByTitle(
        parseCatalogPage(unwrapNodeInvokePayload(raw)),
        params.query.search,
      );
      return {
        ...common,
        connected: true,
        ...page,
        sessions: page.sessions.map((session) => {
          const adopted = params.adoptedSessions.get(adoptedSourceKey(hostId, session.threadId));
          return adopted
            ? Object.assign({}, session, { openClawSessionKey: adopted.key })
            : session;
        }),
      };
    })
    .catch((error: unknown) => ({
      ...common,
      connected: true,
      sessions: [],
      error: catalogError("NODE_INVOKE_FAILED", error),
    }));
  if (params.onHost) {
    // Keep the 8s aggregate response while allowing cold app-server discovery
    // to replace that fail-soft page as soon as the node invoke really settles.
    void eventualHost.then(params.onHost).catch(() => undefined);
  }
  try {
    return await withTimeout(
      eventualHost,
      NODE_CATALOG_LIST_RESPONSE_TIMEOUT_MS,
      "paired node Codex session catalog timed out",
    );
  } catch (error) {
    return {
      ...common,
      connected: true,
      sessions: [],
      error: catalogError("NODE_INVOKE_FAILED", error),
    };
  }
}

async function requireNodeForCodexContinue(params: {
  runtime: PluginRuntime;
  hostId: string;
}): Promise<{ node: CatalogNode; nodeId: string }> {
  const nodeId = params.hostId.slice("node:".length).trim();
  if (!nodeId || params.hostId !== `node:${nodeId}`) {
    throw new CatalogParamsError("Codex session catalog hostId is invalid");
  }
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) => candidate.nodeId === nodeId,
  );
  if (!node || !canContinueCodexOnNode(node)) {
    throw new CatalogParamsError("paired node does not permit Codex session continuation");
  }
  return { node, nodeId };
}

async function resolveNodeCodexRecord(params: {
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
}): Promise<CodexSessionCatalogSession> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      params: {
        limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = parseCatalogPage(unwrapNodeInvokePayload(raw));
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      return record;
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      throw new CatalogParamsError("Codex session eligibility could not be verified");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CatalogParamsError("Codex session is unavailable on the paired node");
}

function requireContinuableNodeRecord(record: CodexSessionCatalogSession): void {
  if (record.archived) {
    throw new CatalogParamsError("Codex session is archived on the paired node");
  }
  if (!isInteractiveThreadSource(record.source)) {
    throw new CatalogParamsError("Codex session is not a non-archived interactive Codex session");
  }
  if (record.status === "idle" || record.status === "notLoaded") {
    // The node App Server is a passive catalog reader, so stored native Codex
    // sessions normally report notLoaded. Node resume serializes OpenClaw turns.
    return;
  }
  if (record.status === "active") {
    throw new CatalogParamsError(
      "Codex session is active on the paired node; wait for it to finish before continuing",
    );
  }
  throw new CatalogParamsError("Codex session cannot be continued in its current state");
}

async function readNodeCodexHistory(params: {
  runtime: PluginRuntime;
  nodeId: string;
  record: CodexSessionCatalogSession;
}): Promise<CodexNodeHistory> {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
    params: {
      threadId: params.record.threadId,
      limit: MAX_TRANSCRIPT_PAGE_LIMIT,
    },
    timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  const page = parseTranscriptPage(unwrapNodeInvokePayload(raw));
  const thread: CodexThread = {
    id: params.record.threadId,
    createdAt: params.record.createdAt ?? 0,
    modelProvider: params.record.modelProvider ?? "openai",
    turns: page.data.toReversed(),
  };
  return { thread, throughTurnId: lastTerminalTurnId(thread) ?? null };
}

async function continueNodeCodexSessionInner(params: {
  api: OpenClawPluginApi;
  config: OpenClawConfig;
  hostId: string;
  threadId: string;
  clientScopes?: readonly string[];
}): Promise<{
  sessionKey: string;
  disposition: CodexSessionDisposition;
  conversationBinding: {
    summary: string;
    detachHint: string;
    data: Record<string, unknown>;
  };
  afterConversationBound: () => Promise<void>;
}> {
  const { nodeId } = await requireNodeForCodexContinue({
    runtime: params.api.runtime,
    hostId: params.hostId,
  });
  const record = await resolveNodeCodexRecord({
    runtime: params.api.runtime,
    nodeId,
    threadId: params.threadId,
  });
  requireContinuableNodeRecord(record);
  const existing = findNodeAdoptedSessionEntry({
    config: params.config,
    runtime: params.api.runtime,
    hostId: params.hostId,
    threadId: params.threadId,
    includeInitializing: true,
  });
  let adopted: AdoptedSessionEntry;
  let disposition: CodexSessionDisposition;
  if (existing) {
    // Unarchive/finalize happens in afterConversationBound so a failed binding
    // install cannot leave a visible session with no node routing.
    adopted = existing;
    disposition = "existing";
  } else {
    const history = await readNodeCodexHistory({
      runtime: params.api.runtime,
      nodeId,
      record,
    });
    adopted = await createOrReuseNodeAdoptedSession({
      api: params.api,
      config: params.config,
      hostId: params.hostId,
      nodeId,
      record,
      history,
    });
    disposition = "forked";
  }
  const marker = nodeSessionMarker({
    hostId: params.hostId,
    threadId: params.threadId,
    nodeId,
  });
  return {
    sessionKey: adopted.key,
    disposition,
    conversationBinding: {
      summary: "Continue this Codex session on its paired node.",
      detachHint: "Start a new chat to leave the paired-node Codex session.",
      data: createCodexCliNodeConversationBindingData({
        nodeId,
        // codex exec resume takes the CLI session id; forked threads share a
        // session tree where the thread id and session id differ.
        sessionId: record.sessionId?.trim() || params.threadId,
        agentId: adopted.agentId,
        cwd: record.cwd,
      }),
    },
    afterConversationBound: async () =>
      await finalizeNodeAdoptedSession({ api: params.api, adopted, marker }),
  };
}

export async function continueNodeCodexSession(params: {
  api: OpenClawPluginApi;
  config: OpenClawConfig;
  hostId: string;
  threadId: string;
  clientScopes?: readonly string[];
}) {
  // Bound turns run native Codex on the node and pass canMutateCodexHost only
  // for owners/admins; gate before the dedupe join so a non-admin caller can
  // neither mint an always-rejected session nor ride an admin's operation.
  if (params.clientScopes?.includes("operator.admin") !== true) {
    throw new CatalogParamsError("continuing a paired-node Codex session requires operator.admin");
  }
  const nodeId = params.hostId.slice("node:".length).trim();
  if (!nodeId || params.hostId !== `node:${nodeId}`) {
    throw new CatalogParamsError("Codex session catalog hostId is invalid");
  }
  const sourceKey = adoptedSourceKey(`node:${nodeId}`, params.threadId);
  const current = continueOperations.get(sourceKey) as
    | Promise<Awaited<ReturnType<typeof continueNodeCodexSessionInner>>>
    | undefined;
  if (current) {
    return await current;
  }
  const operation = runSessionActionExclusive(sourceKey, async () =>
    continueNodeCodexSessionInner(params),
  );
  continueOperations.set(sourceKey, operation);
  try {
    return await operation;
  } finally {
    if (continueOperations.get(sourceKey) === operation) {
      continueOperations.delete(sourceKey);
    }
  }
}
