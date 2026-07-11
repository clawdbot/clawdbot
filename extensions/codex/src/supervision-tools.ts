/**
 * Compatibility tools for the retired Codex Supervisor plugin.
 *
 * Read operations and active-turn controls use the Codex plugin's canonical
 * shared app-server client. Idle threads are never resumed or started here:
 * continuation belongs to the Codex harness, which installs approval and tool
 * handlers before it starts or resumes the harness-owned Codex thread.
 */
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { jsonResult, readStringParam, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerFallbackApiKeyCacheKey,
} from "./app-server/auth-bridge.js";
import {
  assertCodexAppServerConnectionSecurity,
  codexAppServerStartOptionsKey,
  readCodexPluginConfig,
  resolveCodexSupervisionAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
  type CodexSupervisionEndpoint,
} from "./app-server/config.js";
import { requestCodexAppServerJson } from "./app-server/request.js";

/** Legacy endpoint env retained for the shipped Supervisor tool contract. */
export const LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS";
/** Legacy standalone-MCP transcript gate. Agent tools use canonical config. */
export const LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV =
  "OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS";
/** Legacy standalone-MCP write gate. Agent tools use canonical config. */
export const LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV =
  "OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS";

export const CODEX_SUPERVISION_COMPAT_TOOL_NAMES = [
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "codex_session_send",
  "codex_session_interrupt",
] as const;

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const SessionsListParamsSchema = Type.Object(
  {
    include_stored: Type.Optional(Type.Boolean()),
    max_stored_sessions: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);

const SessionReadParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    include_turns: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const SessionSendParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    text: Type.String(),
    mode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("start"), Type.Literal("steer")]),
    ),
  },
  { additionalProperties: false },
);

const SessionInterruptParamsSchema = Type.Object(
  {
    endpoint_id: Type.Optional(Type.String()),
    thread_id: Type.String(),
    turn_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ALL_CODEX_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;
const DEFAULT_MAX_STORED_SESSIONS = 200;
const PAGE_LIMIT = 100;
const MAX_COMPAT_PAGINATION_PAGES = 100;
const MAX_COMPAT_CURSOR_LENGTH = 4096;
const MAX_COMPAT_THREAD_ID_LENGTH = 4096;

type CodexSupervisorTurnMode = "auto" | "start" | "steer";
type CodexSupervisionRequestPolicy = "enabled" | "raw-transcripts" | "write-controls";

class CodexSupervisionPolicyError extends Error {}

type NormalizedSupervisionEndpoint = {
  id: string;
  label?: string;
  configured?: CodexSupervisionEndpoint;
};

type ResolvedSupervisionEndpoint = NormalizedSupervisionEndpoint & {
  connectionKey: string;
};

type CodexSupervisorSession = {
  endpointId: string;
  threadId: string;
  sessionId?: string;
  cwd?: string;
  preview?: string;
  name?: string | null;
  source?: string;
  status: string;
  updatedAt?: number;
  humanAttached?: boolean;
};

type CodexSupervisorEndpointHealth = {
  endpointId: string;
  ok: boolean;
  detail?: string;
};

type CodexSupervisorSessionListResult = {
  sessions: CodexSupervisorSession[];
  errors: CodexSupervisorEndpointHealth[];
};

type EndpointRequest = <T = unknown>(
  endpoint: ResolvedSupervisionEndpoint,
  method: string,
  requestParams?: unknown,
) => Promise<T>;

export type CodexSupervisionToolsOptions = {
  getPluginConfig: () => unknown;
  getRuntimeConfig?: () => OpenClawConfig | undefined;
  /** Trusted owner bit supplied by the plugin tool context. */
  senderIsOwner: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production omits this to use the canonical shared client. */
  request?: EndpointRequest;
  /** Only a trusted standalone MCP adapter may opt into the shipped env gates. */
  useLegacyMcpPolicyEnv?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readCompatNextCursor(value: unknown, method: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_COMPAT_CURSOR_LENGTH
  ) {
    throw new Error(`Codex ${method} returned an invalid nextCursor`);
  }
  return value;
}

function readCompatThreadId(value: unknown, method: string, index: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_COMPAT_THREAD_ID_LENGTH
  ) {
    throw new Error(`Codex ${method} returned an invalid thread id at data[${index}]`);
  }
  return value;
}

function readLoadedThreadIds(data: unknown[]): string[] {
  if (data.length > PAGE_LIMIT) {
    throw new Error(`Codex thread/loaded/list returned more than ${PAGE_LIMIT} entries`);
  }
  return data.map((entry, index) => readCompatThreadId(entry, "thread/loaded/list", index));
}

function readStoredThreads(data: unknown[], maxEntries: number): Record<string, unknown>[] {
  if (data.length > maxEntries) {
    throw new Error(`Codex thread/list returned more than ${maxEntries} entries`);
  }
  return data.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Codex thread/list returned an invalid entry at data[${index}]`);
    }
    readCompatThreadId(entry.id, "thread/list", index);
    return entry;
  });
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function readIntegerParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  if (value < 1 || value > 1000) {
    throw new Error(`${key} must be between 1 and 1000`);
  }
  return value;
}

function readModeParam(params: Record<string, unknown>): CodexSupervisorTurnMode | undefined {
  const mode = readStringParam(params, "mode");
  if (!mode) {
    return undefined;
  }
  if (mode === "auto" || mode === "start" || mode === "steer") {
    return mode;
  }
  throw new Error("mode must be auto, start, or steer");
}

function normalizeEndpointId(value: string, index: number): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "-") : `endpoint-${index + 1}`;
}

function normalizeConfiguredEndpoint(
  endpoint: CodexSupervisionEndpoint,
  index: number,
): NormalizedSupervisionEndpoint {
  const rawId = endpoint.id ?? endpoint.label ?? "";
  return {
    id: normalizeEndpointId(rawId, index),
    ...(endpoint.label?.trim() ? { label: endpoint.label.trim() } : {}),
    configured: endpoint,
  };
}

function parseEndpointRecord(value: unknown): CodexSupervisionEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const transport = typeof value.transport === "string" ? value.transport : undefined;
  const common = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
  };
  if (transport === "websocket" && typeof value.url === "string") {
    return {
      ...common,
      transport,
      url: value.url,
      ...(typeof value.authTokenEnv === "string" ? { authTokenEnv: value.authTokenEnv } : {}),
    };
  }
  if (transport === "stdio-proxy" || transport === undefined) {
    const args = Array.isArray(value.args)
      ? value.args.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return {
      ...common,
      transport: "stdio-proxy",
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  return undefined;
}

function endpointFromToken(token: string, index: number): CodexSupervisionEndpoint | undefined {
  const trimmed = token.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.startsWith("ws://") ||
    trimmed.startsWith("wss://") ||
    trimmed.startsWith("unix://")
  ) {
    return {
      id: normalizeEndpointId("", index),
      transport: "websocket",
      url: trimmed,
    };
  }
  if (trimmed === "local" || trimmed === "proxy" || trimmed === "stdio") {
    return {
      id: "local",
      label: "local Codex app-server",
      transport: "stdio-proxy",
    };
  }
  const separatorIndex = trimmed.indexOf("=");
  const id = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed;
  const url = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : undefined;
  if (url?.startsWith("ws://") || url?.startsWith("wss://") || url?.startsWith("unix://")) {
    return { id: normalizeEndpointId(id, index), transport: "websocket", url };
  }
  return undefined;
}

function requireUniqueEndpointIds(
  endpoints: NormalizedSupervisionEndpoint[],
): NormalizedSupervisionEndpoint[] {
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) {
      throw new Error(`duplicate Codex supervisor endpoint id: ${endpoint.id}`);
    }
    seen.add(endpoint.id);
  }
  return endpoints;
}

function readLegacyEnvEndpoints(env: NodeJS.ProcessEnv): CodexSupervisionEndpoint[] | undefined {
  const raw = env[LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV} must be a JSON array`);
    }
    return parsed
      .map((entry) => parseEndpointRecord(entry))
      .filter((entry): entry is CodexSupervisionEndpoint => Boolean(entry));
  }
  return raw
    .split(",")
    .map(endpointFromToken)
    .filter((entry): entry is CodexSupervisionEndpoint => Boolean(entry));
}

function resolveEndpoints(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv,
  runtimeConfig: OpenClawConfig | undefined,
): ResolvedSupervisionEndpoint[] {
  const configured = readCodexPluginConfig(pluginConfig).supervision?.endpoints;
  const endpoints = configured?.length ? configured : readLegacyEnvEndpoints(env);
  const normalized = endpoints
    ? requireUniqueEndpointIds(endpoints.map(normalizeConfiguredEndpoint))
    : [{ id: "local", label: "local Codex app-server" }];
  return normalized.map((endpoint) => {
    const resolved: ResolvedSupervisionEndpoint = {
      id: endpoint.id,
      connectionKey: supervisionEndpointConnectionKey({
        endpoint,
        pluginConfig,
        env,
        runtimeConfig,
      }),
    };
    if (endpoint.label !== undefined) {
      resolved.label = endpoint.label;
    }
    if (endpoint.configured !== undefined) {
      resolved.configured = endpoint.configured;
    }
    return resolved;
  });
}

function resolveEndpointStartOptions(params: {
  endpoint: NormalizedSupervisionEndpoint;
  pluginConfig: unknown;
  env: NodeJS.ProcessEnv;
  validateSecurity?: boolean;
}): CodexAppServerStartOptions {
  const base = resolveCodexSupervisionAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    env: params.env,
  }).start;
  const configured = params.endpoint.configured;
  if (!configured) {
    return base;
  }
  if (!("url" in configured)) {
    return {
      transport: "stdio",
      homeScope: "user",
      command: configured.command?.trim() || "codex",
      commandSource: "config",
      args: configured.args?.length ? [...configured.args] : ["app-server", "--listen", "stdio://"],
      ...(configured.cwd !== undefined ? { cwd: configured.cwd } : {}),
      headers: {},
    };
  }
  const tokenEnv = configured.authTokenEnv?.trim();
  const authToken = tokenEnv ? params.env[tokenEnv]?.trim() : undefined;
  const startOptions: CodexAppServerStartOptions = {
    transport: configured.url.startsWith("unix://") ? "unix" : "websocket",
    ...(configured.url.startsWith("unix://") ? { homeScope: "user" as const } : {}),
    command: base.command,
    ...(base.commandSource ? { commandSource: base.commandSource } : {}),
    ...(base.managedFallbackCommandPaths
      ? { managedFallbackCommandPaths: [...base.managedFallbackCommandPaths] }
      : {}),
    args: [...base.args],
    url: configured.url,
    ...(authToken ? { authToken } : {}),
    headers: {},
  };
  if (params.validateSecurity !== false) {
    assertCodexAppServerConnectionSecurity(startOptions);
  }
  return startOptions;
}

function supervisionEndpointConnectionKey(params: {
  endpoint: NormalizedSupervisionEndpoint;
  pluginConfig: unknown;
  env: NodeJS.ProcessEnv;
  runtimeConfig: OpenClawConfig | undefined;
}): string {
  // Endpoint probes report unsafe connections as unhealthy; the actual request path still
  // validates security before connecting, while this path only fingerprints live ownership.
  const startOptions = resolveEndpointStartOptions({ ...params, validateSecurity: false });
  const usesNativeAuth =
    params.endpoint.configured !== undefined || startOptions.homeScope === "user";
  const agentDir = usesNativeAuth ? undefined : resolveDefaultAgentDir(params.runtimeConfig ?? {});
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        agentDir,
        config: params.runtimeConfig,
      });
  const fallbackApiKeyCacheKey = authProfileId
    ? undefined
    : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions });
  return JSON.stringify({
    homeScope: startOptions.homeScope ?? null,
    startOptions: codexAppServerStartOptionsKey(startOptions, {
      authProfileId,
      agentDir,
      fallbackApiKeyCacheKey,
    }),
  });
}

function createCanonicalEndpointRequest(options: CodexSupervisionToolsOptions): EndpointRequest {
  return async <T>(
    endpoint: ResolvedSupervisionEndpoint,
    method: string,
    requestParams?: unknown,
  ) => {
    const pluginConfig = options.getPluginConfig();
    const env = options.env ?? process.env;
    const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, env });
    const config = options.getRuntimeConfig?.();
    const startOptions = resolveEndpointStartOptions({
      endpoint,
      pluginConfig,
      env,
    });
    return await requestCodexAppServerJson<T>({
      method,
      requestParams,
      timeoutMs: runtime.requestTimeoutMs,
      startOptions,
      ...(endpoint.configured || startOptions.homeScope === "user" ? { authProfileId: null } : {}),
      ...(config ? { config } : {}),
    });
  };
}

function statusType(thread: Record<string, unknown>): string {
  const status = isRecord(thread.status) ? thread.status.type : thread.status;
  return typeof status === "string" ? status : "unknown";
}

function sourceLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.custom === "string") {
    return `custom:${value.custom}`;
  }
  return Object.keys(value).toSorted()[0];
}

function toSession(
  endpointId: string,
  thread: Record<string, unknown>,
  humanAttached?: boolean,
): CodexSupervisorSession | undefined {
  if (typeof thread.id !== "string") {
    return undefined;
  }
  const source = sourceLabel(thread.source);
  return {
    endpointId,
    threadId: thread.id,
    status: statusType(thread),
    ...(typeof thread.sessionId === "string" ? { sessionId: thread.sessionId } : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(typeof thread.preview === "string" ? { preview: thread.preview } : {}),
    ...(typeof thread.name === "string" || thread.name === null ? { name: thread.name } : {}),
    ...(source ? { source } : {}),
    ...(typeof thread.updatedAt === "number" ? { updatedAt: thread.updatedAt } : {}),
    ...(humanAttached !== undefined ? { humanAttached } : {}),
  };
}

function threadFromRead(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value.thread) ? value.thread : undefined;
}

function isLoadedThreadReadMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("thread not found") || message.includes("thread not loaded");
}

async function readThread(params: {
  request: EndpointRequest;
  endpoint: ResolvedSupervisionEndpoint;
  threadId: string;
  includeTurns: boolean;
}): Promise<Record<string, unknown>> {
  try {
    const response = await params.request(params.endpoint, "thread/read", {
      threadId: params.threadId,
      includeTurns: params.includeTurns,
    });
    const thread = threadFromRead(response);
    if (!thread) {
      throw new Error("Codex thread/read returned an invalid response");
    }
    return thread;
  } catch (error) {
    if (!params.includeTurns || !String(error).includes("not materialized yet")) {
      throw error;
    }
    const response = await params.request(params.endpoint, "thread/read", {
      threadId: params.threadId,
      includeTurns: false,
    });
    const thread = threadFromRead(response);
    if (!thread) {
      throw new Error("Codex thread/read returned an invalid response", { cause: error });
    }
    return thread;
  }
}

async function listLoadedSessions(
  request: EndpointRequest,
  endpoint: ResolvedSupervisionEndpoint,
): Promise<CodexSupervisorSession[]> {
  const sessions: CodexSupervisorSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_COMPAT_PAGINATION_PAGES; pageIndex += 1) {
    const listed = await request(endpoint, "thread/loaded/list", {
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(listed) || !Array.isArray(listed.data)) {
      throw new Error("Codex thread/loaded/list returned an invalid response");
    }
    const threadIds = readLoadedThreadIds(listed.data);
    for (const threadId of threadIds) {
      if (sessions.some((entry) => entry.threadId === threadId)) {
        continue;
      }
      try {
        const thread = await readThread({ request, endpoint, threadId, includeTurns: false });
        const session = toSession(endpoint.id, thread, true);
        if (session) {
          sessions.push(session);
        }
      } catch (error) {
        if (!isLoadedThreadReadMiss(error)) {
          throw error;
        }
      }
    }
    const nextCursor = readCompatNextCursor(listed.nextCursor, "thread/loaded/list");
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(`Codex thread/loaded/list returned repeated cursor ${nextCursor}`);
    }
    if (nextCursor) {
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
    if (!cursor) {
      break;
    }
  }
  if (cursor) {
    throw new Error(
      `Codex thread/loaded/list exceeded ${MAX_COMPAT_PAGINATION_PAGES} pages with a continuation cursor`,
    );
  }
  return sessions;
}

async function listStoredSessions(params: {
  request: EndpointRequest;
  endpoint: ResolvedSupervisionEndpoint;
  limit: number;
}): Promise<CodexSupervisorSession[]> {
  const sessions: CodexSupervisorSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_COMPAT_PAGINATION_PAGES; pageIndex += 1) {
    const remaining = params.limit - sessions.length;
    if (remaining <= 0) {
      break;
    }
    const pageLimit = Math.min(PAGE_LIMIT, remaining);
    const listed = await params.request(params.endpoint, "thread/list", {
      archived: false,
      limit: pageLimit,
      sourceKinds: [...ALL_CODEX_THREAD_SOURCE_KINDS],
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(listed) || !Array.isArray(listed.data)) {
      throw new Error("Codex thread/list returned an invalid response");
    }
    for (const thread of readStoredThreads(listed.data, pageLimit)) {
      if (sessions.length >= params.limit) {
        break;
      }
      const session = toSession(params.endpoint.id, thread);
      if (session && !sessions.some((entry) => entry.threadId === session.threadId)) {
        sessions.push(session);
      }
    }
    const nextCursor = readCompatNextCursor(listed.nextCursor, "thread/list");
    if (nextCursor && sessions.length < params.limit && seenCursors.has(nextCursor)) {
      throw new Error(`Codex thread/list returned repeated cursor ${nextCursor}`);
    }
    if (nextCursor) {
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
    if (!cursor || sessions.length >= params.limit) {
      break;
    }
  }
  if (cursor && sessions.length < params.limit) {
    throw new Error(
      `Codex thread/list exceeded ${MAX_COMPAT_PAGINATION_PAGES} pages with a continuation cursor`,
    );
  }
  return sessions;
}

async function listSessionSnapshot(params: {
  endpoints: ResolvedSupervisionEndpoint[];
  request: EndpointRequest;
  includeStored: boolean;
  maxStoredSessions?: number;
}): Promise<CodexSupervisorSessionListResult> {
  const sessions: CodexSupervisorSession[] = [];
  const errors: CodexSupervisorEndpointHealth[] = [];
  for (const endpoint of params.endpoints) {
    try {
      const loaded = await listLoadedSessions(params.request, endpoint);
      sessions.push(...loaded);
      if (params.includeStored) {
        const stored = await listStoredSessions({
          request: params.request,
          endpoint,
          limit: params.maxStoredSessions ?? DEFAULT_MAX_STORED_SESSIONS,
        });
        for (const session of stored) {
          if (
            !sessions.some(
              (entry) => entry.endpointId === endpoint.id && entry.threadId === session.threadId,
            )
          ) {
            sessions.push(session);
          }
        }
      }
    } catch (error) {
      if (error instanceof CodexSupervisionPolicyError) {
        throw error;
      }
      errors.push({
        endpointId: endpoint.id,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { sessions, errors };
}

async function resolveEndpointForThread(params: {
  endpoints: ResolvedSupervisionEndpoint[];
  request: EndpointRequest;
  endpointId?: string;
  threadId: string;
}): Promise<ResolvedSupervisionEndpoint> {
  if (params.endpointId) {
    const endpoint = params.endpoints.find((entry) => entry.id === params.endpointId);
    if (!endpoint) {
      throw new Error(`Unknown Codex supervisor endpoint: ${params.endpointId}`);
    }
    return endpoint;
  }
  const matches: ResolvedSupervisionEndpoint[] = [];
  for (const endpoint of params.endpoints) {
    try {
      const thread = await readThread({
        request: params.request,
        endpoint,
        threadId: params.threadId,
        includeTurns: false,
      });
      if (thread.id === params.threadId) {
        matches.push(endpoint);
      }
    } catch (error) {
      if (error instanceof CodexSupervisionPolicyError) {
        throw error;
      }
      if (!isLoadedThreadReadMiss(error)) {
        continue;
      }
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Codex thread id is ambiguous across endpoints: ${params.threadId}`);
  }
  throw new Error(`Codex thread not found: ${params.threadId}`);
}

function findInProgressTurnId(thread: Record<string, unknown>): string | undefined {
  const turns = asRecordArray(thread.turns);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.status === "inProgress" && typeof turn.id === "string") {
      return turn.id;
    }
  }
  return undefined;
}

async function resolveInProgressTurnId(params: {
  request: EndpointRequest;
  endpoint: ResolvedSupervisionEndpoint;
  thread: Record<string, unknown>;
  threadId: string;
}): Promise<string | undefined> {
  const inline = findInProgressTurnId(params.thread);
  if (inline) {
    return inline;
  }
  try {
    const response = await params.request(params.endpoint, "thread/turns/list", {
      threadId: params.threadId,
      limit: 10,
      sortDirection: "desc",
      itemsView: "summary",
    });
    return isRecord(response) ? findInProgressTurnId({ turns: response.data }) : undefined;
  } catch (error) {
    if (error instanceof CodexSupervisionPolicyError) {
      throw error;
    }
    return undefined;
  }
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:sk|glpat|xox[baprs])-[-_a-zA-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs)_[-_a-zA-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[-._~+/a-zA-Z0-9]+=*/g, "Bearer [redacted]");
}

/** Redacts secret-bearing fields before legacy tool results leave the plugin. */
export function redactCodexSupervisionValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return /authorization|password|secret|token|api[-_]?key/i.test(key)
      ? "[redacted]"
      : redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCodexSupervisionValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactCodexSupervisionValue(entryValue, entryKey),
    ]),
  );
}

function redactEndpointUrl(value: string): string {
  if (value.startsWith("unix://")) {
    return "unix://";
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?[redacted]";
    }
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

function endpointResult(
  endpoint: ResolvedSupervisionEndpoint,
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const configured = endpoint.configured;
  if (
    configured &&
    (configured.transport === "stdio-proxy" || configured.transport === undefined)
  ) {
    return {
      id: endpoint.id,
      transport: "stdio-proxy",
      ...(endpoint.label ? { label: endpoint.label } : {}),
    };
  }
  if (configured?.transport === "websocket") {
    return {
      id: endpoint.id,
      transport: "websocket",
      ...(endpoint.label ? { label: endpoint.label } : {}),
      url: redactEndpointUrl(configured.url),
    };
  }
  const start = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, env }).start;
  return {
    id: endpoint.id,
    transport: start.transport === "stdio" ? "stdio-proxy" : "websocket",
    ...(endpoint.label ? { label: endpoint.label } : {}),
    ...(start.transport === "stdio"
      ? {}
      : {
          url: redactEndpointUrl(
            start.transport === "unix" ? (start.url ?? "unix://") : (start.url ?? ""),
          ),
        }),
  };
}

function sanitizeSessionListResult(
  result: CodexSupervisorSessionListResult,
  includeTranscriptDerivedFields: boolean,
): Record<string, unknown> {
  return {
    sessions: result.sessions.map((session) => {
      const sanitized = redactCodexSupervisionValue(session) as Record<string, unknown>;
      if (!includeTranscriptDerivedFields) {
        delete sanitized.preview;
        delete sanitized.name;
      }
      return sanitized;
    }),
    errors: includeTranscriptDerivedFields
      ? redactCodexSupervisionValue(result.errors)
      : result.errors.map(({ endpointId, ok }) => ({ endpointId, ok })),
  };
}

function requireSupervisionEnabled(pluginConfig: unknown): void {
  if (readCodexPluginConfig(pluginConfig).supervision?.enabled !== true) {
    throw new CodexSupervisionPolicyError(
      "Codex supervision is disabled in the codex plugin config.",
    );
  }
}

function requireOwnerAccess(options: CodexSupervisionToolsOptions): void {
  if (!options.senderIsOwner) {
    throw new CodexSupervisionPolicyError(
      "Codex supervision compatibility tools require an owner-authorized sender.",
    );
  }
}

function resolveToolPolicy(
  options: CodexSupervisionToolsOptions,
  pluginConfig: unknown,
): {
  allowRawTranscripts: boolean;
  allowWriteControls: boolean;
} {
  const config = readCodexPluginConfig(pluginConfig).supervision;
  const env = options.env ?? process.env;
  return {
    allowRawTranscripts:
      config?.allowRawTranscripts === true ||
      (options.useLegacyMcpPolicyEnv === true &&
        env[LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV] === "1"),
    allowWriteControls:
      config?.allowWriteControls === true ||
      (options.useLegacyMcpPolicyEnv === true &&
        env[LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV] === "1"),
  };
}

function requireRawTranscriptAccess(
  options: CodexSupervisionToolsOptions,
  pluginConfig: unknown,
): void {
  if (!resolveToolPolicy(options, pluginConfig).allowRawTranscripts) {
    throw new CodexSupervisionPolicyError(
      "Codex session reads are disabled for this codex plugin supervision config.",
    );
  }
}

function requireWriteAccess(options: CodexSupervisionToolsOptions, pluginConfig: unknown): void {
  if (!resolveToolPolicy(options, pluginConfig).allowWriteControls) {
    throw new CodexSupervisionPolicyError(
      "Codex write controls are disabled for this codex plugin supervision config.",
    );
  }
}

function requireLiveToolPolicy(
  options: CodexSupervisionToolsOptions,
  policy: CodexSupervisionRequestPolicy,
): { pluginConfig: unknown; endpoints: ResolvedSupervisionEndpoint[] } {
  requireOwnerAccess(options);
  const pluginConfig = options.getPluginConfig();
  requireSupervisionEnabled(pluginConfig);
  if (policy === "raw-transcripts") {
    requireRawTranscriptAccess(options, pluginConfig);
  } else if (policy === "write-controls") {
    requireWriteAccess(options, pluginConfig);
  }
  return {
    pluginConfig,
    endpoints: resolveEndpoints(
      pluginConfig,
      options.env ?? process.env,
      options.getRuntimeConfig?.(),
    ),
  };
}

function requireCurrentEndpoint(
  options: CodexSupervisionToolsOptions,
  policy: CodexSupervisionRequestPolicy,
  endpoint: ResolvedSupervisionEndpoint,
): ResolvedSupervisionEndpoint {
  const { endpoints } = requireLiveToolPolicy(options, policy);
  const currentEndpoint = endpoints.find((candidate) => candidate.id === endpoint.id);
  if (!currentEndpoint || currentEndpoint.connectionKey !== endpoint.connectionKey) {
    throw new CodexSupervisionPolicyError(
      `Codex supervision endpoint ${endpoint.id} was removed or changed during the request.`,
    );
  }
  return currentEndpoint;
}

function requireCurrentEndpointSet(
  options: CodexSupervisionToolsOptions,
  expected: ResolvedSupervisionEndpoint[],
): { pluginConfig: unknown } {
  const current = requireLiveToolPolicy(options, "enabled");
  const unchanged =
    current.endpoints.length === expected.length &&
    expected.every((endpoint) =>
      current.endpoints.some(
        (candidate) =>
          candidate.id === endpoint.id && candidate.connectionKey === endpoint.connectionKey,
      ),
    );
  if (!unchanged) {
    throw new CodexSupervisionPolicyError(
      "Codex supervision endpoint configuration changed during the request.",
    );
  }
  return { pluginConfig: current.pluginConfig };
}

function createPolicyGuardedRequest(
  options: CodexSupervisionToolsOptions,
  request: EndpointRequest,
  policy: CodexSupervisionRequestPolicy,
): EndpointRequest {
  return async <T>(endpoint: ResolvedSupervisionEndpoint, method: string, params?: unknown) => {
    // Configuration can be reloaded while one compatibility call is paginating or resolving a
    // thread. Recheck immediately before every app-server request so revocation stops the call.
    const currentEndpoint = requireCurrentEndpoint(options, policy, endpoint);
    return await request<T>(currentEndpoint, method, params);
  };
}

function idleContinuationError(threadId: string): Error {
  return new Error(
    `Codex thread ${threadId} is idle. Continue it from Codex Sessions so OpenClaw can install the Codex harness approval and tool handlers before resume.`,
  );
}

/** Builds the five shipped Codex Supervisor compatibility tools. */
export function createCodexSupervisionTools(options: CodexSupervisionToolsOptions): AnyAgentTool[] {
  const baseRequest = options.request ?? createCanonicalEndpointRequest(options);
  const request = createPolicyGuardedRequest(options, baseRequest, "enabled");
  const rawTranscriptRequest = createPolicyGuardedRequest(options, baseRequest, "raw-transcripts");
  const writeRequest = createPolicyGuardedRequest(options, baseRequest, "write-controls");
  const current = () => {
    // Keep the execute-time check beside factory filtering so direct/internal
    // callers cannot construct a usable tool without explicit owner authorization.
    return requireLiveToolPolicy(options, "enabled");
  };

  return [
    {
      name: "codex_endpoint_probe",
      label: "Codex Endpoint Probe",
      description: "Check configured Codex app-server endpoints.",
      parameters: EmptyParamsSchema,
      execute: async () => {
        const { pluginConfig, endpoints } = current();
        const health: CodexSupervisorEndpointHealth[] = [];
        for (const endpoint of endpoints) {
          try {
            await request(endpoint, "thread/loaded/list", { limit: 1 });
            health.push({ endpointId: endpoint.id, ok: true });
          } catch (error) {
            if (error instanceof CodexSupervisionPolicyError) {
              throw error;
            }
            health.push({ endpointId: endpoint.id, ok: false });
          }
        }
        requireCurrentEndpointSet(options, endpoints);
        return jsonResult({
          summary: `codex endpoints: ${health.filter((entry) => entry.ok).length}/${health.length} ok`,
          endpoints: endpoints.map((endpoint) =>
            endpointResult(endpoint, pluginConfig, options.env ?? process.env),
          ),
          health,
        });
      },
    },
    {
      name: "codex_sessions_list",
      label: "Codex Sessions List",
      description: "List Codex sessions visible to the OpenClaw supervisor.",
      parameters: SessionsListParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = asRecord(rawParams);
        const { endpoints } = current();
        const result = await listSessionSnapshot({
          endpoints,
          request,
          includeStored: readBooleanParam(params, "include_stored"),
          maxStoredSessions: readIntegerParam(params, "max_stored_sessions"),
        });
        const { pluginConfig } = requireCurrentEndpointSet(options, endpoints);
        return jsonResult({
          summary: `codex sessions: ${result.sessions.length}`,
          ...sanitizeSessionListResult(
            result,
            resolveToolPolicy(options, pluginConfig).allowRawTranscripts,
          ),
        });
      },
    },
    {
      name: "codex_session_read",
      label: "Codex Session Read",
      description: "Read one Codex session transcript from app-server.",
      parameters: SessionReadParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        const { endpoints, pluginConfig } = current();
        requireRawTranscriptAccess(options, pluginConfig);
        const params = asRecord(rawParams);
        const threadId = readStringParam(params, "thread_id", { required: true });
        const endpoint = await resolveEndpointForThread({
          endpoints,
          request: rawTranscriptRequest,
          endpointId: readStringParam(params, "endpoint_id"),
          threadId,
        });
        const thread = await readThread({
          request: rawTranscriptRequest,
          endpoint,
          threadId,
          includeTurns: readBooleanParam(params, "include_turns"),
        });
        requireCurrentEndpoint(options, "raw-transcripts", endpoint);
        return jsonResult({
          summary: `codex session: ${threadId}`,
          response: redactCodexSupervisionValue({ thread }),
        });
      },
    },
    {
      name: "codex_session_send",
      label: "Codex Session Send",
      description:
        "Steer an active Codex turn. Idle sessions must be continued through Codex Sessions.",
      parameters: SessionSendParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        const { endpoints, pluginConfig } = current();
        requireWriteAccess(options, pluginConfig);
        const params = asRecord(rawParams);
        const threadId = readStringParam(params, "thread_id", { required: true });
        const text = readStringParam(params, "text", { required: true, allowEmpty: false });
        const mode = readModeParam(params) ?? "auto";
        if (mode === "start") {
          throw idleContinuationError(threadId);
        }
        const endpoint = await resolveEndpointForThread({
          endpoints,
          request: writeRequest,
          endpointId: readStringParam(params, "endpoint_id"),
          threadId,
        });
        const thread = await readThread({
          request: writeRequest,
          endpoint,
          threadId,
          includeTurns: true,
        });
        requireCurrentEndpoint(options, "write-controls", endpoint);
        if (statusType(thread) !== "active") {
          throw idleContinuationError(threadId);
        }
        const turnId = await resolveInProgressTurnId({
          request: writeRequest,
          endpoint,
          thread,
          threadId,
        });
        if (!turnId) {
          throw new Error(`Codex thread ${threadId} is active but no in-progress turn is readable`);
        }
        await writeRequest(endpoint, "turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        const result = { endpointId: endpoint.id, threadId, mode: "steer" as const, turnId };
        return jsonResult({ summary: `codex steer: ${turnId}`, result });
      },
    },
    {
      name: "codex_session_interrupt",
      label: "Codex Session Interrupt",
      description: "Interrupt an active Codex turn.",
      parameters: SessionInterruptParamsSchema,
      execute: async (_toolCallId, rawParams) => {
        const { endpoints, pluginConfig } = current();
        requireWriteAccess(options, pluginConfig);
        const params = asRecord(rawParams);
        const threadId = readStringParam(params, "thread_id", { required: true });
        const endpoint = await resolveEndpointForThread({
          endpoints,
          request: writeRequest,
          endpointId: readStringParam(params, "endpoint_id"),
          threadId,
        });
        const thread = await readThread({
          request: writeRequest,
          endpoint,
          threadId,
          includeTurns: true,
        });
        requireCurrentEndpoint(options, "write-controls", endpoint);
        if (statusType(thread) !== "active") {
          throw new Error(`Codex thread ${threadId} has no active turn to interrupt`);
        }
        const turnId =
          readStringParam(params, "turn_id") ??
          (await resolveInProgressTurnId({
            request: writeRequest,
            endpoint,
            thread,
            threadId,
          }));
        if (!turnId) {
          throw new Error(`Codex thread ${threadId} has no readable in-progress turn`);
        }
        await writeRequest(endpoint, "turn/interrupt", { threadId, turnId });
        const result = { endpointId: endpoint.id, threadId, turnId };
        return jsonResult({ summary: `codex interrupted: ${turnId}`, result });
      },
    },
  ];
}
