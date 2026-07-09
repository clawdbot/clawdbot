import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CodexSupervisor } from "./supervisor.js";
import type {
  CodexSessionCatalogError,
  CodexSessionCatalogHost,
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
  CodexSessionCatalogSession,
  CodexSupervisorEndpoint,
} from "./types.js";

export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_SESSION_CATALOG_METHOD = "codex-supervisor.sessions.list";

const CODEX_APP_SERVER_THREADS_CAPABILITY = "codex-app-server-threads";
const DEFAULT_PAGE_LIMIT = 50;
export const CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT = 100;
const NODE_INVOKE_TIMEOUT_MS = 20_000;
const MAX_SEARCH_LENGTH = 500;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_COUNT = 100;
const MAX_HOST_COUNT = 100;
const MAX_HOST_ID_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_NAME_LENGTH = 500;
const MAX_METADATA_LENGTH = 500;
const MAX_ACTIVE_FLAGS = 16;

class CatalogParamsError extends Error {}

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];

const DEFAULT_LOCAL_CATALOG_ENDPOINT: CodexSupervisorEndpoint = {
  id: "local",
  label: "Local Codex",
  transport: "stdio-proxy",
};

/** Creates the dedicated local stdio connection used only for catalog metadata. */
export function createCodexSessionCatalogSupervisor(
  configuredEndpoints: CodexSupervisorEndpoint[] = [],
): CodexSupervisor {
  const configuredStdio = configuredEndpoints.find(
    (endpoint) => endpoint.transport === "stdio-proxy",
  );
  return new CodexSupervisor([configuredStdio ?? DEFAULT_LOCAL_CATALOG_ENDPOINT]);
}

function normalizeLimit(value: unknown, key: string): number {
  if (value === undefined) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT
  ) {
    throw new CatalogParamsError(
      `${key} must be an integer from 1 to ${CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT}`,
    );
  }
  return value as number;
}

function readOptionalString(params: Record<string, unknown>, key: string, maxLength: number) {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CatalogParamsError(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new CatalogParamsError(`${key} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function readArchived(params: Record<string, unknown>): boolean {
  if (params.archived !== undefined && typeof params.archived !== "boolean") {
    throw new CatalogParamsError("archived must be a boolean");
  }
  return params.archived === true;
}

function requireOnlyKeys(params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(params).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CatalogParamsError(`unknown Codex session catalog parameter: ${unknown}`);
  }
}

function readPageParams(value: unknown): CodexSessionCatalogPageParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session catalog parameters must be an object");
  }
  const params = value;
  requireOnlyKeys(params, new Set(["cursor", "limit", "archived", "searchTerm", "cwd"]));
  const cursor = readOptionalString(params, "cursor", MAX_CURSOR_LENGTH);
  const searchTerm = readOptionalString(params, "searchTerm", MAX_SEARCH_LENGTH);
  const cwd = readOptionalString(params, "cwd", MAX_CWD_LENGTH);
  return {
    limit: normalizeLimit(params.limit, "limit"),
    archived: readArchived(params),
    ...(cursor ? { cursor } : {}),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function readGatewayParams(value: unknown): CodexSessionCatalogParams {
  if (value !== undefined && !isRecord(value)) {
    throw new CatalogParamsError("Codex session catalog parameters must be an object");
  }
  const params = isRecord(value) ? value : {};
  requireOnlyKeys(params, new Set(["search", "archived", "limitPerHost", "hostIds", "cursors"]));
  const search = readOptionalString(params, "search", MAX_SEARCH_LENGTH);
  let hostIds: string[] | undefined;
  if (params.hostIds !== undefined) {
    if (!Array.isArray(params.hostIds) || params.hostIds.length > MAX_HOST_COUNT) {
      throw new CatalogParamsError(`hostIds must contain at most ${MAX_HOST_COUNT} host ids`);
    }
    hostIds = [...new Set(params.hostIds.map((hostId) => readHostId(hostId)))];
  }
  let cursors: Record<string, string> | undefined;
  if (params.cursors !== undefined) {
    if (!isRecord(params.cursors)) {
      throw new CatalogParamsError("cursors must be an object");
    }
    const entries = Object.entries(params.cursors);
    if (entries.length > MAX_CURSOR_COUNT) {
      throw new CatalogParamsError(`cursors may contain at most ${MAX_CURSOR_COUNT} hosts`);
    }
    cursors = {};
    for (const [hostId, cursor] of entries) {
      const normalizedHostId = hostId.trim();
      if (
        normalizedHostId.length === 0 ||
        normalizedHostId.length > MAX_HOST_ID_LENGTH ||
        (!normalizedHostId.startsWith("gateway:") && !normalizedHostId.startsWith("node:"))
      ) {
        throw new CatalogParamsError(`invalid Codex session catalog host id: ${hostId}`);
      }
      if (
        typeof cursor !== "string" ||
        !cursor.trim() ||
        cursor.trim().length > MAX_CURSOR_LENGTH
      ) {
        throw new CatalogParamsError(`invalid cursor for Codex session catalog host: ${hostId}`);
      }
      cursors[normalizedHostId] = cursor.trim();
    }
  }
  return {
    limitPerHost: normalizeLimit(params.limitPerHost, "limitPerHost"),
    archived: readArchived(params),
    ...(search ? { search } : {}),
    ...(hostIds && hostIds.length > 0 ? { hostIds } : {}),
    ...(cursors && Object.keys(cursors).length > 0 ? { cursors } : {}),
  };
}

function readHostId(value: unknown): string {
  if (typeof value !== "string") {
    throw new CatalogParamsError("Codex session catalog host ids must be strings");
  }
  const hostId = value.trim();
  if (
    hostId.length === 0 ||
    hostId.length > MAX_HOST_ID_LENGTH ||
    (!hostId.startsWith("gateway:") && !hostId.startsWith("node:"))
  ) {
    throw new CatalogParamsError(`invalid Codex session catalog host id: ${value}`);
  }
  return hostId;
}

function parseJsonParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON?.trim()) {
    return {};
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Codex session catalog parameters must be valid JSON", { cause: error });
  }
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalCatalogString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`Codex session catalog returned an invalid ${field}`);
  }
  return value;
}

function parseCatalogSession(value: unknown): CodexSessionCatalogSession {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    value.threadId.length > MAX_SESSION_ID_LENGTH ||
    typeof value.archived !== "boolean"
  ) {
    throw new Error("Codex session catalog returned an invalid session");
  }
  const status = parseOptionalCatalogString(value.status, "status", 64);
  if (!status?.trim()) {
    throw new Error("Codex session catalog returned an invalid status");
  }
  if (value.activeFlags !== undefined && !Array.isArray(value.activeFlags)) {
    throw new Error("Codex session catalog returned invalid active flags");
  }
  if (Array.isArray(value.activeFlags) && value.activeFlags.length > MAX_ACTIVE_FLAGS) {
    throw new Error("Codex session catalog returned too many active flags");
  }
  const activeFlags = Array.isArray(value.activeFlags)
    ? value.activeFlags.map((entry) => {
        const flag = parseOptionalCatalogString(entry, "active flag", 128);
        if (flag === undefined) {
          throw new Error("Codex session catalog returned an invalid active flag");
        }
        return flag;
      })
    : undefined;
  const sessionId = parseOptionalCatalogString(
    value.sessionId,
    "session id",
    MAX_SESSION_ID_LENGTH,
  );
  const name =
    value.name === null
      ? null
      : parseOptionalCatalogString(value.name, "session name", MAX_SESSION_NAME_LENGTH);
  const cwd = parseOptionalCatalogString(value.cwd, "cwd", MAX_CWD_LENGTH);
  const source = parseOptionalCatalogString(value.source, "source", MAX_METADATA_LENGTH);
  const modelProvider = parseOptionalCatalogString(
    value.modelProvider,
    "model provider",
    MAX_METADATA_LENGTH,
  );
  const cliVersion = parseOptionalCatalogString(
    value.cliVersion,
    "CLI version",
    MAX_METADATA_LENGTH,
  );
  const gitBranch = parseOptionalCatalogString(value.gitBranch, "Git branch", MAX_METADATA_LENGTH);
  const createdAt = readFiniteNumber(value.createdAt);
  const updatedAt = readFiniteNumber(value.updatedAt);
  const recencyAt = value.recencyAt === null ? null : readFiniteNumber(value.recencyAt);
  return {
    threadId: value.threadId,
    status,
    archived: value.archived,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(activeFlags && activeFlags.length > 0 ? { activeFlags } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(recencyAt !== undefined ? { recencyAt } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(cliVersion !== undefined ? { cliVersion } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
  };
}

function parseCatalogError(value: unknown): CodexSessionCatalogError | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  return { code: value.code, message: value.message };
}

function parseCatalogPage(value: unknown): CodexSessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT
  ) {
    throw new Error("Codex session catalog returned an invalid page");
  }
  const nextCursor = parseOptionalCatalogString(value.nextCursor, "next cursor", MAX_CURSOR_LENGTH);
  const backwardsCursor = parseOptionalCatalogString(
    value.backwardsCursor,
    "backwards cursor",
    MAX_CURSOR_LENGTH,
  );
  return {
    sessions: value.sessions.map(parseCatalogSession),
    ...(nextCursor ? { nextCursor } : {}),
    ...(backwardsCursor ? { backwardsCursor } : {}),
  };
}

function filterCatalogPageByTitle(
  page: CodexSessionCatalogPage,
  searchTerm: string | undefined,
): CodexSessionCatalogPage {
  if (!searchTerm) {
    return page;
  }
  return {
    ...page,
    sessions: page.sessions.filter((session) => session.name?.includes(searchTerm)),
  };
}

function parseCatalogHost(value: unknown): CodexSessionCatalogHost {
  if (
    !isRecord(value) ||
    typeof value.hostId !== "string" ||
    typeof value.label !== "string" ||
    (value.kind !== "gateway" && value.kind !== "node") ||
    typeof value.connected !== "boolean" ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("Codex session catalog returned an invalid host");
  }
  const page = parseCatalogPage(value);
  const error = parseCatalogError(value.error);
  return {
    hostId: value.hostId,
    label: value.label,
    kind: value.kind,
    connected: value.connected,
    sessions: page.sessions,
    ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
    ...(typeof value.endpointId === "string" ? { endpointId: value.endpointId } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.backwardsCursor ? { backwardsCursor: page.backwardsCursor } : {}),
    ...(error ? { error } : {}),
  };
}

/** Validates and strips unknown fields from a Gateway catalog response. */
export function parseCodexSessionCatalogResult(value: unknown): CodexSessionCatalogResult {
  if (!isRecord(value) || !Array.isArray(value.hosts)) {
    throw new Error("Codex session catalog returned an invalid result");
  }
  return { hosts: value.hosts.map(parseCatalogHost) };
}

function unwrapNodeInvokePayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.payloadJSON === "string" && value.payloadJSON.trim()) {
    try {
      return JSON.parse(value.payloadJSON) as unknown;
    } catch (error) {
      throw new Error("Codex node returned malformed session catalog JSON", { cause: error });
    }
  }
  return "payload" in value ? value.payload : value;
}

function catalogError(code: string, _error: unknown): CodexSessionCatalogError {
  const messages: Record<string, string> = {
    APP_SERVER_UNAVAILABLE: "Codex app-server is unavailable on this host",
    NODE_INVOKE_FAILED: "The paired node could not return its Codex session catalog",
    NODE_LIST_FAILED: "Paired nodes could not be listed",
  };
  return { code, message: messages[code] ?? "Codex session catalog request failed" };
}

function endpointLabel(endpoint: CodexSupervisorEndpoint): string {
  return endpoint.label?.trim() || endpoint.id;
}

function gatewayHostId(endpointId: string): string {
  const direct = `gateway:${endpointId}`;
  if (direct.length <= MAX_HOST_ID_LENGTH) {
    return direct;
  }
  // Existing supervisor endpoint ids are not length-bounded. Keep that public
  // config contract while giving catalog cursors a bounded, stable routing id.
  const digest = createHash("sha256").update(endpointId).digest("hex");
  return `gateway:sha256:${digest}`;
}

async function listGatewayEndpoint(params: {
  supervisor: CodexSupervisor;
  endpoint: CodexSupervisorEndpoint;
  query: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogHost> {
  const hostId = gatewayHostId(params.endpoint.id);
  try {
    const page = filterCatalogPageByTitle(
      parseCatalogPage(
        await params.supervisor.listSessionCatalogPage(params.endpoint.id, {
          cursor: params.query.cursors?.[hostId],
          limit: params.query.limitPerHost,
          archived: params.query.archived,
          searchTerm: params.query.search,
        }),
      ),
      params.query.search,
    );
    return {
      hostId,
      label: endpointLabel(params.endpoint),
      kind: "gateway",
      connected: true,
      endpointId: params.endpoint.id,
      ...page,
    };
  } catch (error) {
    return {
      hostId,
      label: endpointLabel(params.endpoint),
      kind: "gateway",
      connected: true,
      endpointId: params.endpoint.id,
      sessions: [],
      error: catalogError("APP_SERVER_UNAVAILABLE", error),
    };
  }
}

function nodeLabel(node: CatalogNode): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function compareNodeLabels(left: CatalogNode, right: CatalogNode): number {
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

async function listPairedNode(params: {
  runtime: PluginRuntime;
  node: CatalogNode;
  query: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogHost> {
  const hostId = `node:${params.node.nodeId}`;
  const common = {
    hostId,
    label: nodeLabel(params.node),
    kind: "node" as const,
    nodeId: params.node.nodeId,
  };
  if (params.node.connected !== true) {
    return {
      ...common,
      connected: false,
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    };
  }
  try {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.node.nodeId,
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      params: {
        cursor: params.query.cursors?.[hostId],
        limit: params.query.limitPerHost,
        archived: params.query.archived,
        searchTerm: params.query.search,
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
    });
    const page = filterCatalogPageByTitle(
      parseCatalogPage(unwrapNodeInvokePayload(raw)),
      params.query.search,
    );
    return {
      ...common,
      connected: true,
      ...page,
    };
  } catch (error) {
    return {
      ...common,
      connected: true,
      sessions: [],
      error: catalogError("NODE_INVOKE_FAILED", error),
    };
  }
}

/** Lists Gateway-local and paired-node Codex sessions with per-host failures. */
export async function listCodexSessionCatalog(params: {
  runtime: PluginRuntime;
  supervisor: CodexSupervisor;
  query?: CodexSessionCatalogParams;
}): Promise<CodexSessionCatalogResult> {
  const query = readGatewayParams(params.query);
  const requestedHostIds = query.hostIds ? new Set(query.hostIds) : undefined;
  const localHosts = params.supervisor
    .listEndpoints()
    .filter((endpoint) => !requestedHostIds || requestedHostIds.has(gatewayHostId(endpoint.id)))
    .map((endpoint) => listGatewayEndpoint({ supervisor: params.supervisor, endpoint, query }));
  if (requestedHostIds && !query.hostIds?.some((hostId) => hostId.startsWith("node:"))) {
    return { hosts: await Promise.all(localHosts) };
  }
  let nodes: CatalogNode[];
  try {
    nodes = (await params.runtime.nodes.list()).nodes.filter(
      (node) =>
        node.commands?.includes(CODEX_APP_SERVER_THREADS_LIST_COMMAND) &&
        (!requestedHostIds || requestedHostIds.has(`node:${node.nodeId}`)),
    );
  } catch (error) {
    return {
      hosts: [
        ...(await Promise.all(localHosts)),
        {
          hostId: "node:registry",
          label: "Paired nodes",
          kind: "node",
          connected: false,
          sessions: [],
          error: catalogError("NODE_LIST_FAILED", error),
        },
      ],
    };
  }
  const nodeHosts = nodes
    .toSorted(compareNodeLabels)
    .map((node) => listPairedNode({ runtime: params.runtime, node, query }));
  return { hosts: await Promise.all([...localHosts, ...nodeHosts]) };
}

/** Builds the node-local read-only Codex app-server catalog command. */
export function createCodexSessionCatalogNodeHostCommands(
  supervisor: CodexSupervisor,
): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const pageParams = readPageParams(parseJsonParams(paramsJSON));
        const endpoint = supervisor.listEndpoints()[0];
        if (!endpoint) {
          throw new Error("Codex app-server catalog is unavailable");
        }
        try {
          const page = filterCatalogPageByTitle(
            parseCatalogPage(await supervisor.listSessionCatalogPage(endpoint.id, pageParams)),
            pageParams.searchTerm,
          );
          return JSON.stringify(page);
        } catch {
          // App-server stderr and transport details stay on the node boundary.
          throw new Error("Codex app-server catalog is unavailable");
        }
      },
    },
  ];
}

/** Allows the metadata-only catalog command on supported paired-node platforms. */
export function createCodexSessionCatalogNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}

/** Registers the Control UI descriptor and host-grouped Gateway catalog method. */
export function registerCodexSessionCatalogGateway(params: {
  api: OpenClawPluginApi;
  supervisor: CodexSupervisor;
}): void {
  params.api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "sessions",
    label: "Codex Sessions",
    description: "Codex sessions on this Gateway and paired nodes.",
    icon: "terminal",
    group: "control",
    requiredScopes: ["operator.write"],
  });
  params.api.registerGatewayMethod(
    CODEX_SESSION_CATALOG_METHOD,
    async ({ params: requestParams, respond }: GatewayRequestHandlerOptions) => {
      try {
        respond(
          true,
          await listCodexSessionCatalog({
            runtime: params.api.runtime,
            supervisor: params.supervisor,
            query: readGatewayParams(requestParams),
          }),
        );
      } catch (error) {
        if (error instanceof CatalogParamsError) {
          respond(
            false,
            { error: error.message },
            errorShape(ErrorCodes.INVALID_REQUEST, error.message),
          );
          return;
        }
        const message = "Codex session catalog request failed";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    // Core node.invoke is a write-scoped method even for read-only plugin commands.
    { scope: "operator.write" },
  );
}
