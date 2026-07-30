import crypto from "node:crypto";
import {
  buildHostRuntimePreparedFacts,
  type HostRuntimePreparedFacts,
} from "./host-runtime-envelope.js";
import type { JsonObject, JsonValue } from "./protocol.js";

export type RuntimeEnvelopeOwner = "openclaw" | "external-host";

export type EndpointOwner =
  | { kind: "openclaw" }
  | { kind: "external-host"; hostId: string }
  | { kind: "dispatcher"; dispatcherId: string };

export type TurnOwnerDecisionReason =
  | "endpoint-owner"
  | "thread-owner"
  | "dispatcher-decision"
  | "standalone-default";

export type TurnOwnerDecision = {
  owner: RuntimeEnvelopeOwner;
  reason: TurnOwnerDecisionReason;
  endpointId: string;
  threadOwnerId?: string;
  dispatcherId?: string;
  hostId?: string;
  auditId: string;
};

export type DispatcherEventKind = "message" | "reaction" | "webhook" | "command";

export type DispatcherEventIntake = {
  endpointId: string;
  eventKind: DispatcherEventKind;
  payload: unknown;
  idempotencyKey: string;
};

export type DispatcherRouteDecision = {
  intake: DispatcherEventIntake;
  decision: TurnOwnerDecision;
  persistedRouteKey: string;
  invokedRuntime: RuntimeEnvelopeOwner;
};

export type CodexMcpOwnershipConfigErrorCode =
  | "openclaw_ownership_ambiguous"
  | "openclaw_ownership_conflict"
  | "openclaw_ownership_invalid"
  | "openclaw_ownership_missing_fact";

export class CodexMcpOwnershipConfigError extends Error {
  readonly code: CodexMcpOwnershipConfigErrorCode;
  readonly serverName?: string;
  readonly endpointId?: string;

  constructor(params: {
    code: CodexMcpOwnershipConfigErrorCode;
    message: string;
    serverName?: string;
    endpointId?: string;
  }) {
    super(params.message);
    this.name = "CodexMcpOwnershipConfigError";
    this.code = params.code;
    this.serverName = params.serverName;
    this.endpointId = params.endpointId;
  }
}

export type CodexMcpThreadConfig = {
  evaluated: boolean;
  fingerprint?: string;
  configPatch?: JsonObject;
  ownershipDecisions?: Record<string, TurnOwnerDecision>;
  hostRuntimePreparedFacts?: Record<string, HostRuntimePreparedFacts>;
};

const OPENCLAW_TRANSPORT_TO_CODEX_TYPE: Record<string, string> = {
  "streamable-http": "http",
  http: "http",
  sse: "sse",
  stdio: "stdio",
};

export function buildCodexMcpThreadConfig(config: unknown): CodexMcpThreadConfig {
  const mcpServers: Record<string, JsonValue> = {};
  const ownershipDecisions: Record<string, TurnOwnerDecision> = {};
  const hostRuntimeEnvelopeSources: Record<string, unknown> = {};
  for (const [serverName, server] of Object.entries(readConfiguredMcpServers(config)).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalized = normalizeCodexMcpServerConfig(serverName, server);
    if (!normalized) {
      if (hasOpenClawOwnershipConfig(server)) {
        throw new CodexMcpOwnershipConfigError({
          code: "openclaw_ownership_invalid",
          serverName,
          message: `OpenClaw MCP server "${serverName}" declares ownership but has no usable command or url.`,
        });
      }
      continue;
    }
    const ownershipDecision = resolveMcpEndpointOwnershipDecision(serverName, server);
    if (ownershipDecision) {
      addOwnershipDecision(ownershipDecisions, serverName, ownershipDecision);
      addHostRuntimeEnvelopeSource(
        hostRuntimeEnvelopeSources,
        ownershipDecision.endpointId,
        server.openclawRuntimeEnvelope,
      );
    }
    mcpServers[serverName] = normalized;
  }

  const hostRuntimePreparedFacts = buildHostRuntimePreparedFacts({
    ownershipDecisions,
    envelopeSources: hostRuntimeEnvelopeSources,
  });
  const configPatch: JsonObject = {};
  const fingerprintSource: JsonObject = {};
  if (Object.keys(mcpServers).length > 0) {
    configPatch.mcp_servers = mcpServers;
    fingerprintSource.mcp_servers = mcpServers;
  }
  if (Object.keys(ownershipDecisions).length > 0) {
    fingerprintSource.openclaw_ownership = serializeOwnershipDecisions(ownershipDecisions);
  }
  if (hostRuntimePreparedFacts.serialized) {
    fingerprintSource.openclaw_host_runtime = hostRuntimePreparedFacts.serialized;
  }
  if (Object.keys(fingerprintSource).length === 0) {
    return { evaluated: true };
  }
  return {
    evaluated: true,
    fingerprint: fingerprintJson(fingerprintSource),
    ...(Object.keys(configPatch).length > 0 ? { configPatch } : {}),
    ...(Object.keys(ownershipDecisions).length > 0 ? { ownershipDecisions } : {}),
    ...(hostRuntimePreparedFacts.preparedFacts
      ? { hostRuntimePreparedFacts: hostRuntimePreparedFacts.preparedFacts }
      : {}),
  };
}

function hasOpenClawOwnershipConfig(server: Record<string, unknown>): boolean {
  return "openclawOwnership" in server;
}

function resolveMcpEndpointOwnershipDecision(
  serverName: string,
  server: Record<string, unknown>,
): TurnOwnerDecision | undefined {
  if (!hasOpenClawOwnershipConfig(server)) {
    return undefined;
  }
  const raw = server.openclawOwnership;
  if (!isRecord(raw)) {
    throw new CodexMcpOwnershipConfigError({
      code: "openclaw_ownership_invalid",
      serverName,
      message: `OpenClaw MCP server "${serverName}" has invalid ownership config.`,
    });
  }

  const endpointId = readOptionalString(raw.endpointId, "endpointId", serverName) ?? serverName;
  const auditId = readOptionalString(raw.auditId, "auditId", serverName) ?? `mcp:${endpointId}`;
  const threadOwnerId = readOptionalString(raw.threadOwnerId, "threadOwnerId", serverName);
  const runtimeEnvelopeOwner = readRuntimeEnvelopeOwner(raw.runtimeEnvelopeOwner, serverName);
  const endpointOwner = readEndpointOwner(raw.endpointOwner, serverName);
  const sharedEndpoint = readSharedEndpoint(raw.sharedEndpoint, serverName);

  if (!endpointOwner) {
    if (sharedEndpoint) {
      throw new CodexMcpOwnershipConfigError({
        code: "openclaw_ownership_ambiguous",
        serverName,
        endpointId,
        message: `OpenClaw MCP endpoint "${endpointId}" is shared but has no endpoint owner or dispatcher decision.`,
      });
    }
    if (runtimeEnvelopeOwner === "external-host" && !threadOwnerId) {
      throw new CodexMcpOwnershipConfigError({
        code: "openclaw_ownership_missing_fact",
        serverName,
        endpointId,
        message: `OpenClaw MCP endpoint "${endpointId}" cannot assign a Host runtime envelope without a thread owner id.`,
      });
    }
    return cleanTurnOwnerDecision({
      owner: runtimeEnvelopeOwner ?? "openclaw",
      reason: threadOwnerId ? "thread-owner" : "standalone-default",
      endpointId,
      threadOwnerId,
      auditId,
    });
  }

  if (endpointOwner.kind === "openclaw") {
    ensureCompatibleRuntimeOwner({
      expected: "openclaw",
      actual: runtimeEnvelopeOwner,
      serverName,
      endpointId,
    });
    return cleanTurnOwnerDecision({
      owner: "openclaw",
      reason: "endpoint-owner",
      endpointId,
      threadOwnerId,
      auditId,
    });
  }

  if (endpointOwner.kind === "external-host") {
    ensureCompatibleRuntimeOwner({
      expected: "external-host",
      actual: runtimeEnvelopeOwner,
      serverName,
      endpointId,
    });
    return cleanTurnOwnerDecision({
      owner: "external-host",
      reason: "endpoint-owner",
      endpointId,
      threadOwnerId: threadOwnerId ?? endpointOwner.hostId,
      hostId: endpointOwner.hostId,
      auditId,
    });
  }

  if (!runtimeEnvelopeOwner) {
    throw new CodexMcpOwnershipConfigError({
      code: "openclaw_ownership_ambiguous",
      serverName,
      endpointId,
      message: `OpenClaw MCP endpoint "${endpointId}" is dispatcher-owned but has no runtime envelope owner decision.`,
    });
  }
  return cleanTurnOwnerDecision({
    owner: runtimeEnvelopeOwner,
    reason: "dispatcher-decision",
    endpointId,
    threadOwnerId,
    dispatcherId: endpointOwner.dispatcherId,
    auditId,
  });
}

export function buildDispatcherRouteDecision(params: {
  intake: DispatcherEventIntake;
  decision: TurnOwnerDecision;
  persistedRouteKey?: string;
  invokedRuntime?: RuntimeEnvelopeOwner;
}): DispatcherRouteDecision {
  const intake = normalizeDispatcherEventIntake(params.intake);
  const decision = cleanTurnOwnerDecision(params.decision);
  if (decision.reason !== "dispatcher-decision") {
    throwDispatcherContractError({
      code: "openclaw_ownership_conflict",
      endpointId: decision.endpointId,
      message: `OpenClaw dispatcher endpoint "${decision.endpointId}" cannot route a ${decision.reason} ownership decision.`,
    });
  }
  if (!decision.dispatcherId) {
    throwDispatcherContractError({
      code: "openclaw_ownership_missing_fact",
      endpointId: decision.endpointId,
      message: `OpenClaw dispatcher endpoint "${decision.endpointId}" has no dispatcher id.`,
    });
  }
  if (decision.endpointId !== intake.endpointId) {
    throwDispatcherContractError({
      code: "openclaw_ownership_conflict",
      endpointId: intake.endpointId,
      message: `OpenClaw dispatcher intake endpoint "${intake.endpointId}" does not match ownership endpoint "${decision.endpointId}".`,
    });
  }
  const persistedRouteKey = params.persistedRouteKey?.trim();
  if (!persistedRouteKey) {
    throwDispatcherContractError({
      code: "openclaw_ownership_missing_fact",
      endpointId: intake.endpointId,
      message: `OpenClaw dispatcher endpoint "${intake.endpointId}" has no persisted route key.`,
    });
  }
  const invokedRuntime = params.invokedRuntime ?? decision.owner;
  if (invokedRuntime !== decision.owner) {
    throwDispatcherContractError({
      code: "openclaw_ownership_conflict",
      endpointId: intake.endpointId,
      message: `OpenClaw dispatcher endpoint "${intake.endpointId}" selected ${decision.owner} but tried to invoke ${invokedRuntime}.`,
    });
  }
  return {
    intake,
    decision,
    persistedRouteKey,
    invokedRuntime,
  };
}

function addHostRuntimeEnvelopeSource(
  sources: Record<string, unknown>,
  endpointId: string,
  source: unknown,
): void {
  if (source !== undefined && sources[endpointId] === undefined) {
    sources[endpointId] = source;
  }
}

function addOwnershipDecision(
  decisions: Record<string, TurnOwnerDecision>,
  serverName: string,
  decision: TurnOwnerDecision,
): void {
  const existing = decisions[decision.endpointId];
  if (existing && !areTurnOwnerDecisionsEqual(existing, decision)) {
    throw new CodexMcpOwnershipConfigError({
      code: "openclaw_ownership_ambiguous",
      serverName,
      endpointId: decision.endpointId,
      message: `OpenClaw MCP endpoint "${decision.endpointId}" has conflicting ownership decisions.`,
    });
  }
  decisions[decision.endpointId] = decision;
}

function ensureCompatibleRuntimeOwner(params: {
  expected: RuntimeEnvelopeOwner;
  actual?: RuntimeEnvelopeOwner;
  serverName: string;
  endpointId: string;
}): void {
  if (params.actual && params.actual !== params.expected) {
    throw new CodexMcpOwnershipConfigError({
      code: "openclaw_ownership_conflict",
      serverName: params.serverName,
      endpointId: params.endpointId,
      message: `OpenClaw MCP endpoint "${params.endpointId}" declares ${params.expected} ownership but ${params.actual} runtime envelope ownership.`,
    });
  }
}

function readEndpointOwner(value: unknown, serverName: string): EndpointOwner | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "openclaw") {
    return { kind: "openclaw" };
  }
  if (!isRecord(value) || typeof value.kind !== "string") {
    throwInvalidOwnership(serverName, "endpointOwner");
  }
  if (value.kind === "openclaw") {
    return { kind: "openclaw" };
  }
  if (value.kind === "external-host") {
    return {
      kind: "external-host",
      hostId: readRequiredString(value.hostId, "endpointOwner.hostId", serverName),
    };
  }
  if (value.kind === "dispatcher") {
    return {
      kind: "dispatcher",
      dispatcherId: readRequiredString(
        value.dispatcherId,
        "endpointOwner.dispatcherId",
        serverName,
      ),
    };
  }
  throwInvalidOwnership(serverName, "endpointOwner.kind");
}

function readRuntimeEnvelopeOwner(
  value: unknown,
  serverName: string,
): RuntimeEnvelopeOwner | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "openclaw" || value === "external-host") {
    return value;
  }
  throwInvalidOwnership(serverName, "runtimeEnvelopeOwner");
}

function readSharedEndpoint(value: unknown, serverName: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throwInvalidOwnership(serverName, "sharedEndpoint");
}

function normalizeDispatcherEventIntake(value: unknown): DispatcherEventIntake {
  if (!isRecord(value)) {
    throwDispatcherContractError({
      code: "openclaw_ownership_invalid",
      message: "OpenClaw dispatcher intake must be an object.",
    });
  }
  const endpointId = readRequiredDispatcherString(value.endpointId, "intake.endpointId");
  const idempotencyKey = readRequiredDispatcherString(
    value.idempotencyKey,
    "intake.idempotencyKey",
  );
  if (!isDispatcherEventKind(value.eventKind)) {
    throwDispatcherContractError({
      code: "openclaw_ownership_invalid",
      endpointId,
      message: `OpenClaw dispatcher endpoint "${endpointId}" has invalid event kind.`,
    });
  }
  return {
    endpointId,
    eventKind: value.eventKind,
    payload: value.payload,
    idempotencyKey,
  };
}

function isDispatcherEventKind(value: unknown): value is DispatcherEventKind {
  return value === "message" || value === "reaction" || value === "webhook" || value === "command";
}

function readRequiredDispatcherString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwDispatcherContractError({
    code: "openclaw_ownership_invalid",
    message: `OpenClaw dispatcher route has invalid field "${fieldName}".`,
  });
}

function throwDispatcherContractError(params: {
  code: CodexMcpOwnershipConfigErrorCode;
  endpointId?: string;
  message: string;
}): never {
  throw new CodexMcpOwnershipConfigError({
    code: params.code,
    endpointId: params.endpointId,
    message: params.message,
  });
}

function readRequiredString(value: unknown, fieldName: string, serverName: string): string {
  const result = readOptionalString(value, fieldName, serverName);
  if (result) {
    return result;
  }
  throwInvalidOwnership(serverName, fieldName);
}

function readOptionalString(
  value: unknown,
  fieldName: string,
  serverName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throwInvalidOwnership(serverName, fieldName);
}

function throwInvalidOwnership(serverName: string, fieldName: string): never {
  throw new CodexMcpOwnershipConfigError({
    code: "openclaw_ownership_invalid",
    serverName,
    message: `OpenClaw MCP server "${serverName}" has invalid ownership field "${fieldName}".`,
  });
}

function cleanTurnOwnerDecision(decision: TurnOwnerDecision): TurnOwnerDecision {
  return Object.fromEntries(
    Object.entries(decision).filter(([, value]) => value !== undefined),
  ) as TurnOwnerDecision;
}

function serializeOwnershipDecisions(decisions: Record<string, TurnOwnerDecision>): JsonObject {
  const serialized: JsonObject = {};
  for (const [endpointId, decision] of Object.entries(decisions).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    serialized[endpointId] = serializeTurnOwnerDecision(decision);
  }
  return serialized;
}

function serializeTurnOwnerDecision(decision: TurnOwnerDecision): JsonObject {
  return cleanTurnOwnerDecision({ ...decision }) as unknown as JsonObject;
}

function areTurnOwnerDecisionsEqual(left: TurnOwnerDecision, right: TurnOwnerDecision): boolean {
  return (
    JSON.stringify(stabilizeJsonObject(serializeTurnOwnerDecision(left))) ===
    JSON.stringify(stabilizeJsonObject(serializeTurnOwnerDecision(right)))
  );
}

function readConfiguredMcpServers(config: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(config)) {
    return {};
  }
  const mcp = config.mcp;
  if (!isRecord(mcp) || !isRecord(mcp.servers)) {
    return {};
  }
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [serverName, server] of Object.entries(mcp.servers)) {
    if (typeof serverName !== "string" || !serverName.trim() || !isRecord(server)) {
      continue;
    }
    servers[serverName] = { ...server };
  }
  return servers;
}

function normalizeCodexMcpServerConfig(
  name: string,
  server: Record<string, unknown>,
): JsonObject | undefined {
  const next: JsonObject = {};

  applyCommonServerConfig(next, server);
  const rawTransport = server.transport;
  if (typeof server.type === "string") {
    next.type = server.type;
  } else if (typeof rawTransport === "string") {
    const mapped = OPENCLAW_TRANSPORT_TO_CODEX_TYPE[rawTransport.trim().toLowerCase()];
    if (mapped) {
      next.type = mapped;
    }
  }

  if (isOpenClawLoopbackMcpServer(name, server)) {
    next.default_tools_approval_mode = "approve";
  }

  applyHttpHeaderConfig(next, server.headers);

  if (typeof next.command !== "string" && typeof next.url !== "string") {
    return undefined;
  }
  return stabilizeJsonObject(next);
}

function applyCommonServerConfig(next: JsonObject, server: Record<string, unknown>): void {
  if (typeof server.command === "string") {
    next.command = server.command;
  }
  const args = normalizeStringArray(server.args);
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.env = env;
  }
  if (typeof server.cwd === "string") {
    next.cwd = server.cwd;
  }
  if (typeof server.url === "string") {
    next.url = server.url;
  }
}

function applyHttpHeaderConfig(next: JsonObject, headers: unknown): void {
  const httpHeaders = normalizeStringRecord(headers);
  if (!httpHeaders) {
    return;
  }
  const staticHeaders: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(httpHeaders).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const decoded = decodeHeaderEnvPlaceholder(value);
    if (!decoded) {
      staticHeaders[headerName] = value;
      continue;
    }
    if (decoded.bearer && headerName.trim().toLowerCase() === "authorization") {
      next.bearer_token_env_var = decoded.envVar;
      continue;
    }
    envHeaders[headerName] = decoded.envVar;
  }
  if (Object.keys(staticHeaders).length > 0) {
    next.http_headers = staticHeaders;
  }
  if (Object.keys(envHeaders).length > 0) {
    next.env_http_headers = envHeaders;
  }
}

function isOpenClawLoopbackMcpServer(name: string, server: Record<string, unknown>): boolean {
  return (
    name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
  );
}

function decodeHeaderEnvPlaceholder(value: string): { envVar: string; bearer: boolean } | null {
  const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
  if (bearerMatch) {
    return { envVar: bearerMatch[1], bearer: true };
  }
  const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
  if (envMatch) {
    return { envVar: envMatch[1], bearer: false };
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function fingerprintJson(value: JsonValue): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stabilizeJsonValue(value)))
    .digest("hex");
}

function stabilizeJsonObject(value: JsonObject): JsonObject {
  return stabilizeJsonValue(value) as JsonObject;
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child as JsonValue);
  }
  return stable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
