/**
 * Config parsing for Codex Supervisor endpoints and safety gates.
 */
import { Type, type Static } from "typebox";
import type { CodexSupervisorEndpoint } from "./types.js";

const ENDPOINTS_ENV = "OPENCLAW_CODEX_SUPERVISOR_ENDPOINTS";

const StdioEndpointSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    transport: Type.Optional(Type.Literal("stdio-proxy")),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WebSocketEndpointSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    transport: Type.Literal("websocket"),
    url: Type.String(),
    authTokenEnv: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * Plugin config schema accepted by the bundled plugin manifest.
 */
export const CodexSupervisorPluginConfigSchema = Type.Object(
  {
    endpoints: Type.Optional(
      Type.Array(Type.Union([StdioEndpointSchema, WebSocketEndpointSchema])),
    ),
    allowRawTranscripts: Type.Optional(Type.Boolean({ default: false })),
    allowWriteControls: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

/** Raw plugin config shape accepted from OpenClaw config. */
export type CodexSupervisorPluginConfig = Static<typeof CodexSupervisorPluginConfigSchema>;

/** Normalized config consumed by plugin registration and MCP serving. */
export type ResolvedCodexSupervisorPluginConfig = {
  endpoints: CodexSupervisorEndpoint[];
  allowRawTranscripts: boolean;
  allowWriteControls: boolean;
};

function normalizeEndpointId(value: string, index: number): string {
  const trimmed = value.trim();
  if (trimmed) {
    return trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "-");
  }
  return `endpoint-${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseEndpointRecord(value: unknown, index: number): CodexSupervisorEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const transport = typeof value.transport === "string" ? value.transport : undefined;
  const id =
    typeof value.id === "string"
      ? normalizeEndpointId(value.id, index)
      : normalizeEndpointId(typeof value.label === "string" ? value.label : "", index);
  const label = typeof value.label === "string" ? value.label : undefined;
  if (transport === "websocket" && typeof value.url === "string") {
    return {
      id,
      transport,
      url: value.url,
      ...(label ? { label } : {}),
      ...(typeof value.authTokenEnv === "string" ? { authTokenEnv: value.authTokenEnv } : {}),
    };
  }
  if (transport === "stdio-proxy" || transport === undefined) {
    const args = Array.isArray(value.args)
      ? value.args.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return {
      id,
      transport: "stdio-proxy",
      ...(label ? { label } : {}),
      ...(typeof value.command === "string" ? { command: value.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  return undefined;
}

function requireUniqueEndpointIds(endpoints: CodexSupervisorEndpoint[]): CodexSupervisorEndpoint[] {
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) {
      throw new Error(`duplicate Codex supervisor endpoint id: ${endpoint.id}`);
    }
    seen.add(endpoint.id);
  }
  return endpoints;
}

function endpointFromToken(token: string, index: number): CodexSupervisorEndpoint | undefined {
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
      label: "local Codex app-server daemon",
      transport: "websocket",
      url: "unix://",
    };
  }
  const separatorIndex = trimmed.indexOf("=");
  const id = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed;
  const url = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : undefined;
  if (url?.startsWith("ws://") || url?.startsWith("wss://") || url?.startsWith("unix://")) {
    return {
      id: normalizeEndpointId(id ?? "", index),
      transport: "websocket",
      url,
    };
  }
  return undefined;
}

/**
 * Loads endpoint definitions from environment, defaulting to the local Codex
 * app-server unix socket.
 */
export function loadCodexSupervisorEndpoints(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): CodexSupervisorEndpoint[] {
  const raw = env[ENDPOINTS_ENV]?.trim();
  if (!raw) {
    return requireUniqueEndpointIds([
      {
        id: "local",
        label: "local Codex app-server daemon",
        transport: "websocket",
        url: "unix://",
      },
    ]);
  }
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${ENDPOINTS_ENV} must be a JSON array`);
    }
    return requireUniqueEndpointIds(
      parsed
        .map((entry, index) => parseEndpointRecord(entry, index))
        .filter((entry): entry is CodexSupervisorEndpoint => Boolean(entry)),
    );
  }
  return requireUniqueEndpointIds(
    raw
      .split(",")
      .map(endpointFromToken)
      .filter((entry): entry is CodexSupervisorEndpoint => Boolean(entry)),
  );
}

function normalizeConfiguredEndpoints(
  endpoints: CodexSupervisorPluginConfig["endpoints"],
): CodexSupervisorEndpoint[] | undefined {
  if (!endpoints || endpoints.length === 0) {
    return undefined;
  }
  const normalized = endpoints
    .map((entry, index) => parseEndpointRecord(entry, index))
    .filter((entry): entry is CodexSupervisorEndpoint => Boolean(entry));
  return normalized.length > 0 ? requireUniqueEndpointIds(normalized) : undefined;
}

/**
 * Resolves raw plugin config and env endpoints into validated runtime config.
 */
export function resolveCodexSupervisorPluginConfig(
  rawConfig: unknown,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): ResolvedCodexSupervisorPluginConfig {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as CodexSupervisorPluginConfig)
      : {};
  return {
    endpoints: normalizeConfiguredEndpoints(config.endpoints) ?? loadCodexSupervisorEndpoints(env),
    allowRawTranscripts: config.allowRawTranscripts === true,
    allowWriteControls: config.allowWriteControls === true,
  };
}
