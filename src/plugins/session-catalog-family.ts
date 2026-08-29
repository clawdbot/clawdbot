import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import {
  decodeNodePtyResumeParams,
  resolveNodeHostExecutable,
  runNodePtyCommand,
} from "../plugin-sdk/node-host.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  createSessionCatalogAdoptionCoordinator,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogContinueProviderResult,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogListProviderParams,
  type SessionCatalogProvider,
} from "./session-catalog.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeInvokePolicy,
} from "./types.js";

type SessionCatalogPage = {
  sessions: SessionCatalogSession[];
  nextCursor?: string;
};

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type MaybePromise<T> = T | Promise<T>;

type SessionCatalogCapabilityProjection = {
  canContinue: boolean;
  canOpenTerminal: boolean;
};

type SessionCatalogFamilyMessages = {
  invalidNodeCursor: string;
  invalidNodeSessionPage: string;
  invalidNodeTranscriptPage: string;
  invalidHostId: string;
  localReadFailed: string;
  nodeInvokeFailed: string;
  nodeReadUnavailable: string;
  nodeTerminalUnavailable: string;
  sessionUnavailable: string;
};

type SessionCatalogTerminalOptions = {
  executable: string;
  args: (threadId: string) => string[];
  title: (threadId: string) => string;
  requireLocalSession: (threadId: string) => Promise<SessionCatalogSession>;
  unavailableMessage: string;
};

type SessionCatalogContinuationOptions<TResult extends SessionCatalogContinueProviderResult> = {
  resolveAgentId: (requestedAgentId?: string) => string;
  availability: () => MaybePromise<{ available: true } | { available: false; message: string }>;
  listAdopted: (
    agentId?: string,
    sessionEntries?: SessionCatalogEntrySnapshot,
  ) => MaybePromise<ReadonlyMap<string, string>>;
  loadSession: (threadId: string) => Promise<SessionCatalogSession>;
  validateSession: (session: SessionCatalogSession) => void;
  create: (params: {
    agentId: string;
    hostId: string;
    threadId: string;
    session: SessionCatalogSession;
  }) => Promise<{ sessionKey: string }>;
  complete: (continued: { sessionKey: string }, threadId: string) => Promise<TResult>;
  nodeReadOnlyMessage: string;
};

export type SessionCatalogFamilyOptions<
  TResult extends SessionCatalogContinueProviderResult = SessionCatalogContinueProviderResult,
> = {
  runtime: PluginRuntime;
  local: {
    hostId: string;
    label: string;
    available: (query: SessionCatalogListProviderParams) => MaybePromise<boolean>;
    list: (query: SessionCatalogListProviderParams) => Promise<SessionCatalogPage>;
    read: (
      request: Parameters<SessionCatalogProvider["read"]>[0],
    ) => Promise<SessionsCatalogReadResult>;
    assertAccess: (hostId: string, allowProcessHomeFallback?: boolean) => void;
  };
  node: {
    listCommand: string;
    readCommand: string;
    terminalCommand: string;
    timeoutMs: number;
    maxHosts: number;
    maxPageLimit: number;
    sessionIdPattern: RegExp;
  };
  capabilities: {
    local: () => MaybePromise<SessionCatalogCapabilityProjection>;
    node: (node: CatalogNode) => SessionCatalogCapabilityProjection;
    project: (
      session: SessionCatalogSession,
      capabilities: SessionCatalogCapabilityProjection,
    ) => SessionCatalogSession;
  };
  messages: SessionCatalogFamilyMessages;
  continuation: SessionCatalogContinuationOptions<TResult>;
  terminal: SessionCatalogTerminalOptions;
  checkUpstreamActivity: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>;
};

function nodeLabel(node: { displayName?: string; remoteIp?: string; nodeId: string }): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function unwrapNodePayload(value: unknown): unknown {
  return isRecord(value) && typeof value.payloadJSON === "string"
    ? (JSON.parse(value.payloadJSON) as unknown)
    : value;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isNodeSession(value: unknown, sessionIdPattern: RegExp): value is SessionCatalogSession {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    sessionIdPattern.test(value.threadId) &&
    typeof value.status === "string" &&
    value.status.length > 0 &&
    typeof value.archived === "boolean" &&
    typeof value.canContinue === "boolean" &&
    typeof value.canArchive === "boolean" &&
    isOptionalString(value.name) &&
    isOptionalString(value.cwd) &&
    isOptionalString(value.source) &&
    isOptionalString(value.modelProvider) &&
    isOptionalString(value.cliVersion) &&
    isOptionalString(value.gitBranch) &&
    isOptionalString(value.sessionKey) &&
    isOptionalNumber(value.createdAt) &&
    isOptionalNumber(value.updatedAt) &&
    isOptionalNumber(value.recencyAt)
  );
}

const TRANSCRIPT_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "toolCall",
  "toolResult",
  "other",
]);

function isNodeTranscriptItem(value: unknown): value is SessionCatalogTranscriptItem {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    TRANSCRIPT_ITEM_TYPES.has(value.type) &&
    isOptionalString(value.id) &&
    isOptionalString(value.text) &&
    isOptionalString(value.timestamp) &&
    isOptionalString(value.model) &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}

function parseNodeSessionPage(
  value: unknown,
  options: SessionCatalogFamilyOptions,
  isExactCursor: (value: unknown) => value is string,
): SessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > options.node.maxPageLimit ||
    !value.sessions.every((session) => isNodeSession(session, options.node.sessionIdPattern))
  ) {
    throw new Error(options.messages.invalidNodeSessionPage);
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && !isExactCursor(nextCursor)) {
    throw new Error(options.messages.invalidNodeCursor);
  }
  return {
    sessions: value.sessions,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function parseNodeTranscriptPage(
  value: unknown,
  threadId: string,
  options: SessionCatalogFamilyOptions,
  isExactCursor: (value: unknown) => value is string,
): SessionsCatalogReadResult {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    !Array.isArray(value.items) ||
    value.items.length > options.node.maxPageLimit ||
    !value.items.every(isNodeTranscriptItem)
  ) {
    throw new Error(options.messages.invalidNodeTranscriptPage);
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && !isExactCursor(nextCursor)) {
    throw new Error(options.messages.invalidNodeCursor);
  }
  return {
    hostId: options.local.hostId,
    threadId,
    items: value.items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function projectPageCapabilities(
  page: SessionCatalogPage,
  capabilities: SessionCatalogCapabilityProjection,
  project: SessionCatalogFamilyOptions["capabilities"]["project"],
): SessionCatalogPage {
  return {
    ...page,
    sessions: page.sessions.map((session) => project(session, capabilities)),
  };
}

function projectAdoptedSessions(
  page: SessionCatalogPage,
  adopted: ReadonlyMap<string, string>,
  localHostId: string,
): SessionCatalogPage {
  return {
    ...page,
    sessions: page.sessions.map((session) => {
      const sessionKey = adopted.get(sessionCatalogAdoptedSourceKey(localHostId, session.threadId));
      return sessionKey ? { ...session, sessionKey } : session;
    }),
  };
}

async function listNodeHost(
  options: SessionCatalogFamilyOptions,
  query: SessionCatalogListProviderParams,
  node: CatalogNode,
  isExactCursor: (value: unknown) => value is string,
): Promise<SessionCatalogHost> {
  const hostId = `node:${node.nodeId}`;
  const common = {
    hostId,
    label: nodeLabel(node),
    kind: "node" as const,
    connected: node.connected === true,
    nodeId: node.nodeId,
  };
  if (node.connected !== true) {
    return {
      ...common,
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    };
  }
  try {
    const cursor = query.cursors?.[hostId];
    if (cursor !== undefined && !isExactCursor(cursor)) {
      throw new Error("cursor is invalid");
    }
    const raw = await options.runtime.nodes.invoke({
      nodeId: node.nodeId,
      command: options.node.listCommand,
      params: {
        ...(query.limitPerHost ? { limit: query.limitPerHost } : {}),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      timeoutMs: options.node.timeoutMs,
      scopes: ["operator.write"],
    });
    const page = parseNodeSessionPage(unwrapNodePayload(raw), options, isExactCursor);
    return {
      ...common,
      ...projectPageCapabilities(
        page,
        options.capabilities.node(node),
        options.capabilities.project,
      ),
    };
  } catch {
    return {
      ...common,
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED", message: options.messages.nodeInvokeFailed },
    };
  }
}

async function listHosts(
  options: SessionCatalogFamilyOptions,
  query: SessionCatalogListProviderParams,
  isExactCursor: (value: unknown) => value is string,
): Promise<SessionCatalogHost[]> {
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: SessionCatalogHost[] = [];
  if (
    (!requested || requested.has(options.local.hostId)) &&
    (await options.local.available(query))
  ) {
    try {
      const capabilities = await options.capabilities.local();
      const adopted = query.sessionEntries
        ? await options.continuation.listAdopted(query.agentId, query.sessionEntries)
        : new Map<string, string>();
      const page = projectAdoptedSessions(
        projectPageCapabilities(
          await options.local.list(query),
          capabilities,
          options.capabilities.project,
        ),
        adopted,
        options.local.hostId,
      );
      const host: SessionCatalogHost = {
        hostId: options.local.hostId,
        label: options.local.label,
        kind: "gateway",
        connected: true,
        ...page,
      };
      hosts.push(host);
      query.onHost?.(host);
    } catch {
      const host: SessionCatalogHost = {
        hostId: options.local.hostId,
        label: options.local.label,
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: options.messages.localReadFailed },
      };
      hosts.push(host);
      query.onHost?.(host);
    }
  }
  let nodes: CatalogNode[];
  try {
    nodes = (await (query.listNodes?.() ?? options.runtime.nodes.list())).nodes;
  } catch {
    return hosts;
  }
  const eligible = nodes
    .filter(
      (node) =>
        node.commands?.includes(options.node.listCommand) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)))
    .slice(0, options.node.maxHosts - hosts.length);
  const pending = eligible.map((node) =>
    listNodeHost(options, query, node, isExactCursor).then((host) => {
      query.onHost?.(host);
      return host;
    }),
  );
  return [...hosts, ...(await Promise.all(pending))];
}

async function readTranscript(
  options: SessionCatalogFamilyOptions,
  request: Parameters<SessionCatalogProvider["read"]>[0],
  isExactCursor: (value: unknown) => value is string,
): Promise<SessionsCatalogReadResult> {
  if (request.cursor !== undefined && !isExactCursor(request.cursor)) {
    throw new Error("cursor is invalid");
  }
  if (request.hostId === options.local.hostId) {
    options.local.assertAccess(request.hostId, request.allowProcessHomeFallback);
    return await options.local.read(request);
  }
  if (!request.hostId.startsWith("node:")) {
    throw new Error(options.messages.invalidHostId);
  }
  const nodeId = request.hostId.slice("node:".length);
  const node = (await options.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(options.node.readCommand),
  );
  if (!node) {
    throw new Error(options.messages.nodeReadUnavailable);
  }
  const raw = await options.runtime.nodes.invoke({
    nodeId,
    command: options.node.readCommand,
    params: {
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    },
    timeoutMs: options.node.timeoutMs,
    scopes: ["operator.write"],
  });
  return {
    ...parseNodeTranscriptPage(unwrapNodePayload(raw), request.threadId, options, isExactCursor),
    hostId: request.hostId,
    label: nodeLabel(node),
  };
}

async function openTerminal(
  options: SessionCatalogFamilyOptions,
  request: Parameters<NonNullable<SessionCatalogProvider["openTerminal"]>>[0],
  isExactCursor: (value: unknown) => value is string,
) {
  const title = options.terminal.title(request.threadId);
  if (request.hostId === options.local.hostId) {
    options.local.assertAccess(request.hostId, request.allowProcessHomeFallback);
    const session = await options.terminal.requireLocalSession(request.threadId);
    const resolution = resolveNodeHostExecutable(options.terminal.executable, {
      env: process.env,
      pathEnv: process.env.PATH ?? "",
      strategy: "fallback",
    });
    if (!resolution) {
      throw new Error(options.terminal.unavailableMessage);
    }
    return {
      kind: "local" as const,
      argv: [resolution.executable, ...options.terminal.args(request.threadId)],
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
      title,
    };
  }
  if (!request.hostId.startsWith("node:")) {
    throw new Error(options.messages.invalidHostId);
  }
  const nodeId = request.hostId.slice("node:".length);
  const node = (await options.runtime.nodes.list()).nodes.find((candidate) => {
    const commands = candidate.invocableCommands ?? candidate.commands;
    return (
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      commands?.includes(options.node.listCommand) === true &&
      commands.includes(options.node.terminalCommand)
    );
  });
  if (!node) {
    throw new Error(options.messages.nodeTerminalUnavailable);
  }
  const raw = await options.runtime.nodes.invoke({
    nodeId,
    command: options.node.listCommand,
    params: { searchTerm: request.threadId, limit: options.node.maxPageLimit },
    timeoutMs: options.node.timeoutMs,
    scopes: ["operator.write"],
  });
  const page = parseNodeSessionPage(unwrapNodePayload(raw), options, isExactCursor);
  const session = page.sessions.find((candidate) => candidate.threadId === request.threadId);
  if (!session) {
    throw new Error(options.messages.sessionUnavailable);
  }
  return {
    kind: "node" as const,
    nodeId,
    command: options.node.terminalCommand,
    paramsJSON: JSON.stringify({ threadId: request.threadId }),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    title,
  };
}

/** Compose the shared local-plus-paired-node runtime for one CLI session-catalog family. */
export function createSessionCatalogFamily(
  options: SessionCatalogFamilyOptions,
  isExactCursor: (value: unknown) => value is string,
): Required<
  Pick<
    SessionCatalogProvider,
    "list" | "read" | "continueSession" | "checkUpstreamActivity" | "openTerminal"
  >
> {
  const continueAdoption =
    createSessionCatalogAdoptionCoordinator<SessionCatalogContinueProviderResult>();
  return {
    list: async (query) => await listHosts(options, query, isExactCursor),
    read: async (request) => await readTranscript(options, request, isExactCursor),
    continueSession: async (request) => {
      options.local.assertAccess(request.hostId, request.allowProcessHomeFallback);
      if (request.hostId.startsWith("node:")) {
        throw new Error(options.continuation.nodeReadOnlyMessage);
      }
      if (request.hostId !== options.local.hostId) {
        throw new Error(options.messages.invalidHostId);
      }
      const available = await options.continuation.availability();
      if (!available.available) {
        throw new Error(available.message);
      }
      const agentId = options.continuation.resolveAgentId(request.agentId);
      const sourceKey = sessionCatalogAdoptedSourceKey(request.hostId, request.threadId);
      // Scope in-flight results to the agent without changing host/thread adoption lookup keys.
      const operationKey = `${agentId}\0${sourceKey}`;
      return await continueAdoption({
        sourceKey: operationKey,
        findExisting: async () => (await options.continuation.listAdopted(agentId)).get(sourceKey),
        create: async () => {
          const session = await options.continuation.loadSession(request.threadId);
          options.continuation.validateSession(session);
          const current = await options.continuation.availability();
          if (!current.available) {
            throw new Error(current.message);
          }
          return await options.continuation.create({
            agentId,
            hostId: request.hostId,
            threadId: request.threadId,
            session,
          });
        },
        complete: async (continued) =>
          await options.continuation.complete(continued, request.threadId),
      });
    },
    checkUpstreamActivity: options.checkUpstreamActivity,
    openTerminal: async (request) => await openTerminal(options, request, isExactCursor),
  };
}

export type SessionCatalogNodeHostBindingsOptions = {
  capability: string;
  listCommand: string;
  readCommand: string;
  terminalCommand: string;
  sessionIdPattern: RegExp;
  executable: string;
  args: (threadId: string) => string[];
  listAvailable: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => boolean;
  terminalAvailable: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => boolean;
  parseParams: (paramsJSON?: string | null) => unknown;
  list: (params: unknown) => Promise<SessionCatalogPage>;
  read: (params: unknown) => Promise<SessionsCatalogReadResult>;
  requireSession: (threadId: string) => Promise<SessionCatalogSession>;
  terminalIoRequiredMessage: string;
  terminalUnavailableMessage: string;
  invalidThreadIdMessage: string;
};

/** Build the three node-host commands and their explicit terminal-only invoke policy. */
export function createSessionCatalogNodeHostBindings(
  options: SessionCatalogNodeHostBindingsOptions,
): {
  commands: OpenClawPluginNodeHostCommand[];
  policies: OpenClawPluginNodeInvokePolicy[];
} {
  const terminal: OpenClawPluginNodeHostCommand = {
    command: options.terminalCommand,
    cap: options.capability,
    dangerous: false,
    duplex: true,
    isAvailable: options.terminalAvailable,
    handle: async (paramsJSON, io) => {
      if (!io) {
        throw new Error(options.terminalIoRequiredMessage);
      }
      const params = decodeNodePtyResumeParams(paramsJSON, (value) => {
        if (typeof value !== "string" || !options.sessionIdPattern.test(value)) {
          throw new Error(options.invalidThreadIdMessage);
        }
        return value;
      });
      const session = await options.requireSession(params.threadId);
      const resolution = resolveNodeHostExecutable(options.executable, {
        env: process.env,
        pathEnv: process.env.PATH ?? process.env.Path ?? "",
        strategy: "direct",
      });
      if (!resolution) {
        throw new Error(options.terminalUnavailableMessage);
      }
      return JSON.stringify(
        await runNodePtyCommand(
          {
            file: resolution.executable,
            args: options.args(params.threadId),
            cwd: session.cwd,
            cols: params.cols,
            rows: params.rows,
          },
          io,
        ),
      );
    },
  };
  return {
    commands: [
      {
        command: options.listCommand,
        cap: options.capability,
        dangerous: false,
        isAvailable: options.listAvailable,
        handle: async (paramsJSON) =>
          JSON.stringify(await options.list(options.parseParams(paramsJSON))),
      },
      {
        command: options.readCommand,
        cap: options.capability,
        dangerous: false,
        isAvailable: options.listAvailable,
        handle: async (paramsJSON) =>
          JSON.stringify(await options.read(options.parseParams(paramsJSON))),
      },
      terminal,
    ],
    policies: [
      {
        commands: [options.listCommand, options.readCommand, options.terminalCommand],
        defaultPlatforms: ["macos", "linux", "windows"],
        handle: (context) =>
          context.command === options.terminalCommand ? { ok: true } : context.invokeNode(),
      },
    ],
  };
}
