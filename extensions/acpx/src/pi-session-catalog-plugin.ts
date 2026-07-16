import process from "node:process";
import {
  decodeNodePtyResumeParams,
  resolveNodeHostExecutable,
  runNodePtyCommand,
} from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogSession,
  SessionCatalogTerminalPlan,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listLocalPiSessionPage,
  optionalPiString,
  readLocalPiTranscriptPage,
  type PiSessionPage,
} from "./pi-session-catalog.js";
import { piSessionStoreAvailable } from "./pi-session-paths.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";
const PI_TERMINAL_RESUME_COMMAND = "acpx.pi.terminal.resume.v1";

const CAPABILITY = "pi-sessions";
const LOCAL_HOST_ID = "gateway";
const MAX_PAGE_LIMIT = 100;
const MAX_HOSTS = 100;
const MAX_CURSOR_LENGTH = 128;
const NODE_TIMEOUT_MS = 20_000;
const SESSION_ID_PATTERN = /^(?!-)[A-Za-z0-9._:-]{1,256}$/u;
const TRANSCRIPT_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "toolCall",
  "toolResult",
  "other",
]);

function validatePiThreadId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("INVALID_REQUEST: threadId is invalid");
  }
  return value;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isNodeSession(value: unknown): value is SessionCatalogSession {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    SESSION_ID_PATTERN.test(value.threadId) &&
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
    isOptionalString(value.openClawSessionKey) &&
    isOptionalNumber(value.createdAt) &&
    isOptionalNumber(value.updatedAt) &&
    isOptionalNumber(value.recencyAt)
  );
}

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

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Pi session parameters must be valid JSON", { cause: error });
  }
}

function fullConfigCatalogEnabled(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return true;
  }
  const entry = config.plugins.entries.acpx;
  if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.piSessionCatalog)) {
    return true;
  }
  return entry.config.piSessionCatalog.enabled !== false;
}

function isPiSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.piSessionCatalog) ||
    pluginConfig.piSessionCatalog.enabled !== false
  );
}

function createPiSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const storeAvailable = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && piSessionStoreAvailable(env);
  return [
    {
      command: PI_SESSIONS_LIST_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: storeAvailable,
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalPiSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: PI_SESSION_READ_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: storeAvailable,
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalPiTranscriptPage(parseNodeParams(paramsJSON))),
    },
    {
      command: PI_TERMINAL_RESUME_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      duplex: true,
      isAvailable: ({ config, env }) =>
        storeAvailable({ config, env }) &&
        Boolean(
          resolveNodeHostExecutable("pi", {
            env,
            pathEnv: env.PATH ?? env.Path ?? "",
            strategy: "direct",
          }),
        ),
      handle: async (paramsJSON, io) => {
        if (!io) {
          throw new Error("Pi terminal command requires duplex transport");
        }
        const params = decodeNodePtyResumeParams(paramsJSON, validatePiThreadId);
        const record = await requireLocalPiSession(params.threadId);
        const resolution = resolveNodeHostExecutable("pi", {
          env: process.env,
          pathEnv: process.env.PATH ?? process.env.Path ?? "",
          strategy: "direct",
        });
        if (!resolution) {
          throw new Error("Pi CLI is unavailable");
        }
        return JSON.stringify(
          await runNodePtyCommand(
            {
              file: resolution.executable,
              args: ["--session", params.threadId],
              cwd: record.cwd,
              cols: params.cols,
              rows: params.rows,
            },
            io,
          ),
        );
      },
    },
  ];
}

function createPiSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND, PI_TERMINAL_RESUME_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === PI_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
    },
  ];
}

function nodeLabel(node: { displayName?: string; remoteIp?: string; nodeId: string }): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function unwrapNodePayload(value: unknown): unknown {
  return isRecord(value) && typeof value.payloadJSON === "string"
    ? (JSON.parse(value.payloadJSON) as unknown)
    : value;
}

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];

function setTerminalCapability(page: PiSessionPage, canOpenTerminal: boolean): PiSessionPage {
  for (const session of page.sessions) {
    session.canOpenTerminal = canOpenTerminal;
  }
  return page;
}

async function listPiNodeHost(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
  node: CatalogNode,
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
    const raw = await runtime.nodes.invoke({
      nodeId: node.nodeId,
      command: PI_SESSIONS_LIST_COMMAND,
      params: {
        ...(query.limitPerHost ? { limit: query.limitPerHost } : {}),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(query.cursors?.[hostId] ? { cursor: query.cursors[hostId] } : {}),
      },
      timeoutMs: NODE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = parseNodeSessionPage(unwrapNodePayload(raw));
    const commands = node.invocableCommands ?? node.commands;
    const canOpenTerminal = commands?.includes(PI_TERMINAL_RESUME_COMMAND) === true;
    return {
      ...common,
      ...setTerminalCapability(page, canOpenTerminal),
    };
  } catch {
    return {
      ...common,
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED", message: "Paired node Pi sessions are unavailable" },
    };
  }
}

function parseNodeSessionPage(value: unknown): PiSessionPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Pi node returned an invalid session page");
  }
  if (!value.sessions.every(isNodeSession)) {
    throw new Error("Pi node returned an invalid session page");
  }
  const sessions = value.sessions;
  const nextCursor = optionalPiString(value.nextCursor, MAX_CURSOR_LENGTH);
  if (value.nextCursor !== undefined && !nextCursor) {
    throw new Error("Pi node returned an invalid cursor");
  }
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

function parseNodeTranscriptPage(value: unknown, threadId: string): SessionsCatalogReadResult {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PAGE_LIMIT ||
    !value.items.every(isNodeTranscriptItem)
  ) {
    throw new Error("Pi node returned an invalid transcript page");
  }
  const nextCursor = optionalPiString(value.nextCursor, MAX_CURSOR_LENGTH);
  if (value.nextCursor !== undefined && !nextCursor) {
    throw new Error("Pi node returned an invalid cursor");
  }
  return {
    hostId: LOCAL_HOST_ID,
    threadId,
    items: value.items,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function listPiHosts(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
): Promise<SessionCatalogHost[]> {
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: SessionCatalogHost[] = [];
  if ((!requested || requested.has(LOCAL_HOST_ID)) && piSessionStoreAvailable(process.env)) {
    try {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local Pi",
        kind: "gateway",
        connected: true,
        ...(await listLocalPiSessionPage({
          limit: query.limitPerHost,
          ...(query.search ? { searchTerm: query.search } : {}),
          cursor: query.cursors?.[LOCAL_HOST_ID],
        }).then((page) =>
          setTerminalCapability(
            page,
            resolveNodeHostExecutable("pi", {
              env: process.env,
              pathEnv: process.env.PATH ?? "",
              strategy: "fallback",
            }) !== undefined,
          ),
        )),
      });
    } catch {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local Pi",
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: "Local Pi sessions are unavailable" },
      });
    }
  }
  let nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
  try {
    nodes = (await runtime.nodes.list()).nodes;
  } catch {
    return hosts;
  }
  const eligible = nodes
    .filter(
      (node) =>
        node.commands?.includes(PI_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)))
    .slice(0, MAX_HOSTS - hosts.length);
  const nodeHosts = await Promise.all(eligible.map((node) => listPiNodeHost(runtime, query, node)));
  return [...hosts, ...nodeHosts];
}

async function requireLocalPiSession(threadId: string): Promise<SessionCatalogSession> {
  const page = await listLocalPiSessionPage({ searchTerm: threadId, limit: MAX_PAGE_LIMIT });
  const record = page.sessions.find((session) => session.threadId === threadId);
  if (!record) {
    throw new Error("Pi session is unavailable");
  }
  return record;
}

async function resolveNodePiSession(params: {
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
}): Promise<SessionCatalogSession> {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: PI_SESSIONS_LIST_COMMAND,
    params: { searchTerm: params.threadId, limit: MAX_PAGE_LIMIT },
    timeoutMs: NODE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  const page = parseNodeSessionPage(unwrapNodePayload(raw));
  const record = page.sessions.find((session) => session.threadId === params.threadId);
  if (!record) {
    throw new Error("Pi session is unavailable");
  }
  return record;
}

async function openPiTerminal(params: {
  runtime: PluginRuntime;
  hostId: string;
  threadId: string;
}): Promise<SessionCatalogTerminalPlan> {
  const title = `pi --session ${params.threadId.slice(0, 12)}…`;
  if (params.hostId === LOCAL_HOST_ID) {
    const record = await requireLocalPiSession(params.threadId);
    const resolution = resolveNodeHostExecutable("pi", {
      env: process.env,
      pathEnv: process.env.PATH ?? "",
      strategy: "fallback",
    });
    if (!resolution) {
      throw new Error("Pi CLI is unavailable");
    }
    return {
      kind: "local",
      argv: [resolution.executable, "--session", params.threadId],
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
      title,
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new Error("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find((candidate) => {
    const commands = candidate.invocableCommands ?? candidate.commands;
    return (
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      commands?.includes(PI_SESSIONS_LIST_COMMAND) === true &&
      commands.includes(PI_TERMINAL_RESUME_COMMAND)
    );
  });
  if (!node) {
    throw new Error("paired-node Pi terminal is unavailable");
  }
  const record = await resolveNodePiSession({
    runtime: params.runtime,
    nodeId,
    threadId: params.threadId,
  });
  return {
    kind: "node",
    nodeId,
    command: PI_TERMINAL_RESUME_COMMAND,
    paramsJSON: JSON.stringify({ threadId: params.threadId }),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    title,
  };
}

async function readPiTranscript(
  runtime: PluginRuntime,
  request: Parameters<SessionCatalogProvider["read"]>[0],
): Promise<SessionsCatalogReadResult> {
  if (request.hostId === LOCAL_HOST_ID) {
    return await readLocalPiTranscriptPage({
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
  }
  if (!request.hostId.startsWith("node:")) {
    throw new Error("hostId is invalid");
  }
  const nodeId = request.hostId.slice("node:".length);
  const node = (await runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(PI_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new Error("paired-node Pi session host is unavailable");
  }
  const raw = await runtime.nodes.invoke({
    nodeId,
    command: PI_SESSION_READ_COMMAND,
    params: {
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
    },
    timeoutMs: NODE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  return {
    ...parseNodeTranscriptPage(unwrapNodePayload(raw), request.threadId),
    hostId: request.hostId,
    label: nodeLabel(node),
  };
}

export function registerPiSessionCatalog(api: OpenClawPluginApi): void {
  if (!isPiSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  api.registerSessionCatalog({
    id: "pi",
    label: "Pi",
    list: async (query) => await listPiHosts(api.runtime, query),
    read: async (request) => await readPiTranscript(api.runtime, request),
    openTerminal: async (request) => await openPiTerminal({ runtime: api.runtime, ...request }),
  });
  for (const command of createPiSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createPiSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
