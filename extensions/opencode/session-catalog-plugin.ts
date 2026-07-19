import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
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
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENCODE_LOCAL_SESSION_HOST_ID as LOCAL_HOST_ID,
  OPENCODE_NODE_INVOKE_TIMEOUT_MS as NODE_TIMEOUT_MS,
  OPENCODE_SESSIONS_CAPABILITY as CAPABILITY,
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT as MAX_PAGE_LIMIT,
  OPENCODE_SESSION_ID_PATTERN as SESSION_ID_PATTERN,
  OPENCODE_SESSION_READ_COMMAND,
  OPENCODE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";
import {
  createOpenCodeTerminalNodeHostCommand,
  openOpenCodeCatalogTerminal,
} from "./session-catalog-terminal.js";
import {
  isExactOpenCodeSessionCursor,
  listLocalOpenCodeSessionPage,
  readLocalOpenCodeTranscriptPage,
  type OpenCodeSessionPage,
} from "./session-catalog.js";

const MAX_HOSTS = 100;
const TRANSCRIPT_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "toolCall",
  "toolResult",
  "other",
]);

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

function executableOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      if (!directory.trim()) {
        continue;
      }
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) {
          continue;
        }
        if (process.platform !== "win32") {
          accessSync(candidate, constants.X_OK);
        }
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("OpenCode session parameters must be valid JSON", { cause: error });
  }
}

function fullConfigCatalogEnabled(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return true;
  }
  const entry = config.plugins.entries.opencode;
  if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.sessionCatalog)) {
    return true;
  }
  return entry.config.sessionCatalog.enabled !== false;
}

function isOpenCodeSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.sessionCatalog) ||
    pluginConfig.sessionCatalog.enabled !== false
  );
}

function createOpenCodeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const available = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && executableOnPath("opencode", env);
  return [
    {
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalOpenCodeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: OPENCODE_SESSION_READ_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalOpenCodeTranscriptPage(parseNodeParams(paramsJSON))),
    },
    createOpenCodeTerminalNodeHostCommand(available),
  ];
}

function createOpenCodeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [
        OPENCODE_SESSIONS_LIST_COMMAND,
        OPENCODE_SESSION_READ_COMMAND,
        OPENCODE_TERMINAL_RESUME_COMMAND,
      ],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === OPENCODE_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
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

function setTerminalCapability(
  page: OpenCodeSessionPage,
  canOpenTerminal: boolean,
): OpenCodeSessionPage {
  for (const session of page.sessions) {
    session.canOpenTerminal = canOpenTerminal;
  }
  return page;
}

async function listOpenCodeNodeHost(
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
    const cursor = query.cursors?.[hostId];
    if (cursor !== undefined && !isExactOpenCodeSessionCursor(cursor)) {
      throw new Error("cursor is invalid");
    }
    const raw = await runtime.nodes.invoke({
      nodeId: node.nodeId,
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      params: {
        ...(query.limitPerHost ? { limit: query.limitPerHost } : {}),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      timeoutMs: NODE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = parseNodeSessionPage(unwrapNodePayload(raw));
    const commands = node.invocableCommands ?? node.commands;
    const canOpenTerminal = commands?.includes(OPENCODE_TERMINAL_RESUME_COMMAND) === true;
    return {
      ...common,
      ...setTerminalCapability(page, canOpenTerminal),
    };
  } catch {
    return {
      ...common,
      sessions: [],
      error: {
        code: "NODE_INVOKE_FAILED",
        message: "Paired node OpenCode sessions are unavailable",
      },
    };
  }
}

function parseNodeSessionPage(value: unknown): OpenCodeSessionPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("OpenCode node returned an invalid session page");
  }
  if (!value.sessions.every(isNodeSession)) {
    throw new Error("OpenCode node returned an invalid session page");
  }
  const sessions = value.sessions;
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && !isExactOpenCodeSessionCursor(nextCursor)) {
    throw new Error("OpenCode node returned an invalid cursor");
  }
  return { sessions, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

function parseNodeTranscriptPage(value: unknown, threadId: string): SessionsCatalogReadResult {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PAGE_LIMIT ||
    !value.items.every(isNodeTranscriptItem)
  ) {
    throw new Error("OpenCode node returned an invalid transcript page");
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== undefined && !isExactOpenCodeSessionCursor(nextCursor)) {
    throw new Error("OpenCode node returned an invalid cursor");
  }
  return {
    hostId: LOCAL_HOST_ID,
    threadId,
    items: value.items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function listOpenCodeHosts(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
): Promise<SessionCatalogHost[]> {
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: SessionCatalogHost[] = [];
  if (
    (!requested || requested.has(LOCAL_HOST_ID)) &&
    resolveNodeHostExecutable("opencode", {
      env: process.env,
      pathEnv: process.env.PATH ?? "",
      strategy: "fallback",
    })
  ) {
    try {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local OpenCode",
        kind: "gateway",
        connected: true,
        ...(await listLocalOpenCodeSessionPage({
          limit: query.limitPerHost,
          ...(query.search ? { searchTerm: query.search } : {}),
          cursor: query.cursors?.[LOCAL_HOST_ID],
        }).then((page) => setTerminalCapability(page, true))),
      });
    } catch {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local OpenCode",
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: "Local OpenCode sessions are unavailable" },
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
        node.commands?.includes(OPENCODE_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)))
    .slice(0, MAX_HOSTS - hosts.length);
  const nodeHosts = await Promise.all(
    eligible.map((node) => listOpenCodeNodeHost(runtime, query, node)),
  );
  return [...hosts, ...nodeHosts];
}

async function readOpenCodeTranscript(
  runtime: PluginRuntime,
  request: Parameters<SessionCatalogProvider["read"]>[0],
): Promise<SessionsCatalogReadResult> {
  const cursor = request.cursor;
  if (cursor !== undefined && !isExactOpenCodeSessionCursor(cursor)) {
    throw new Error("cursor is invalid");
  }
  if (request.hostId === LOCAL_HOST_ID) {
    return await readLocalOpenCodeTranscriptPage({
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
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
      candidate.commands?.includes(OPENCODE_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new Error("paired-node OpenCode session host is unavailable");
  }
  const raw = await runtime.nodes.invoke({
    nodeId,
    command: OPENCODE_SESSION_READ_COMMAND,
    params: {
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
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

export function registerOpenCodeSessionCatalog(api: OpenClawPluginApi): void {
  if (!isOpenCodeSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  api.registerSessionCatalog({
    id: "opencode",
    label: "OpenCode",
    list: async (query) => await listOpenCodeHosts(api.runtime, query),
    read: async (request) => await readOpenCodeTranscript(api.runtime, request),
    openTerminal: async (request) =>
      await openOpenCodeCatalogTerminal({
        runtime: api.runtime,
        ...request,
        parseNodeSessionPage,
        unwrapNodePayload,
      }),
  });
  for (const command of createOpenCodeSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createOpenCodeSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
