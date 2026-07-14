// Hermes MCP config mapping and manual follow-up planning.
import { createMigrationManualItem } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { mcpValueHasEnvReferences, resolveMcpEnvReferences } from "./config-env.js";
import { readPositiveNumber } from "./config-provider-contract.js";
import { isRecord, readString, sanitizeName } from "./helpers.js";

const MCP_RESOURCE_UTILITY_TOOLS = ["resources_list", "resources_read"] as const;
const MCP_PROMPT_UTILITY_TOOLS = ["prompts_list", "prompts_get"] as const;

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readBooleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  return ["false", "0", "no", "off"].includes(normalized) ? false : undefined;
}

function readPositiveNumeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return readPositiveNumber(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return readPositiveNumber(Number(value));
}

function readToolFilterList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  return normalized;
}

function mapHermesToolFilter(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = isRecord(value.toolFilter)
    ? value.toolFilter
    : isRecord(value.tool_filter)
      ? value.tool_filter
      : undefined;
  if (direct) {
    const include = readToolFilterList(direct.include);
    const exclude = readToolFilterList(direct.exclude);
    if (include && include.length > 0) {
      return { include };
    }
    return exclude !== undefined && exclude.length > 0 ? { exclude } : undefined;
  }

  const tools = isRecord(value.tools) ? value.tools : undefined;
  if (!tools) {
    return undefined;
  }
  const include = readToolFilterList(tools.include);
  const exclude = readToolFilterList(tools.exclude);
  const resourcesEnabled = readBooleanish(tools.resources) !== false;
  const promptsEnabled = readBooleanish(tools.prompts) !== false;

  // Hermes tests set truthiness here: `include: []` means no whitelist, so native tools remain.
  if (include && include.length > 0) {
    return {
      include: [
        ...include,
        ...(resourcesEnabled ? MCP_RESOURCE_UTILITY_TOOLS : []),
        ...(promptsEnabled ? MCP_PROMPT_UTILITY_TOOLS : []),
      ],
    };
  }
  const translatedExclude = [
    ...(exclude ?? []),
    ...(!resourcesEnabled ? MCP_RESOURCE_UTILITY_TOOLS : []),
    ...(!promptsEnabled ? MCP_PROMPT_UTILITY_TOOLS : []),
  ];
  return translatedExclude.length > 0 ? { exclude: translatedExclude } : undefined;
}

function mapHermesClientCertificate(value: Record<string, unknown>): {
  clientCert?: string;
  clientKey?: string;
} {
  const cert = value.clientCert ?? value.client_cert;
  const key = readString(value.clientKey) ?? readString(value.client_key);
  if (Array.isArray(cert) && cert.length === 2) {
    const certPath = readString(cert[0]);
    const keyPath = readString(cert[1]);
    return certPath && keyPath ? { clientCert: certPath, clientKey: keyPath } : {};
  }
  const certPath = readString(cert);
  return certPath && key ? { clientCert: certPath, clientKey: key } : {};
}

const MCP_CONNECTION_FIELDS = [
  "enabled",
  "command",
  "args",
  "cwd",
  "workingDirectory",
  "url",
  "connectionTimeoutMs",
  "requestTimeoutMs",
  "timeout",
] as const;

export function importsMcpSensitiveValues(
  value: Record<string, unknown>,
  includeSecrets: boolean,
): boolean {
  return (
    includeSecrets &&
    (value.env !== undefined ||
      value.headers !== undefined ||
      MCP_CONNECTION_FIELDS.some((key) => mcpValueHasEnvReferences(value[key])))
  );
}

function mapHermesMcpOauth(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const oauth = isRecord(value.oauth) ? value.oauth : undefined;
  if (!oauth) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const key of ["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"]) {
    const fieldValue = readString(oauth[key]);
    if (fieldValue) {
      mapped[key] = fieldValue;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function mapMcpServer(
  value: Record<string, unknown>,
  includeSecrets: boolean,
  env: Record<string, string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of MCP_CONNECTION_FIELDS) {
    const sourceValue = value[key];
    if (sourceValue === undefined) {
      continue;
    }
    if (!mcpValueHasEnvReferences(sourceValue)) {
      next[key] = sourceValue;
      continue;
    }
    if (includeSecrets) {
      const resolved = resolveMcpEnvReferences(sourceValue, env);
      if (!resolved.unresolved) {
        next[key] = resolved.value;
      }
    }
  }
  const transport = readString(value.transport) ?? readString(value.type);
  if (transport === "http" || transport === "streamable-http") {
    next.transport = "streamable-http";
  } else if (transport === "sse" || transport === "stdio") {
    next.transport = transport;
  } else if (!transport && readString(next.url)) {
    next.transport = "streamable-http";
  }
  next.connectTimeout = value.connectTimeout ?? value.connect_timeout;
  next.supportsParallelToolCalls = readBoolean(
    value.supportsParallelToolCalls ?? value.supports_parallel_tool_calls,
  );
  next.sslVerify = readBoolean(value.sslVerify ?? value.ssl_verify);
  next.auth = readString(value.auth) === "oauth" ? "oauth" : undefined;
  next.oauth = mapHermesMcpOauth(value);
  Object.assign(next, mapHermesClientCertificate(value));
  const toolFilter = mapHermesToolFilter(value);
  next.toolFilter = toolFilter;
  if (includeSecrets) {
    for (const key of ["env", "headers"]) {
      if (value[key] !== undefined) {
        const resolved = resolveMcpEnvReferences(value[key], env);
        if (!resolved.unresolved) {
          next[key] = resolved.value;
        }
      }
    }
  }
  const mapped = Object.fromEntries(
    Object.entries(next).filter(([, entry]) => entry !== undefined),
  );
  return readString(mapped.command) || readString(mapped.url) ? mapped : {};
}

export function mcpManualItems(params: {
  name: string;
  raw: Record<string, unknown>;
  includeSecrets: boolean;
  env: Record<string, string>;
  source: string;
}): MigrationItem[] {
  const { name, raw } = params;
  const safeName = sanitizeName(name);
  const items: MigrationItem[] = [];
  const add = (suffix: string, message: string, recommendation: string): void => {
    items.push(
      createMigrationManualItem({
        id: `manual:mcp-server-${suffix}:${safeName}`,
        source: params.source,
        message,
        recommendation,
      }),
    );
  };

  const interpolatedValues = [
    ...MCP_CONNECTION_FIELDS.map((key) => raw[key]),
    raw.env,
    raw.headers,
  ];
  if (
    !params.includeSecrets &&
    (raw.env !== undefined ||
      raw.headers !== undefined ||
      interpolatedValues.some(mcpValueHasEnvReferences))
  ) {
    add(
      "secrets",
      `Hermes MCP server "${name}" has environment-backed values that were not imported without secret consent.`,
      "Re-run with --include-secrets or configure these values manually.",
    );
  }
  if (
    params.includeSecrets &&
    interpolatedValues.some(
      (value) => value !== undefined && resolveMcpEnvReferences(value, params.env).unresolved,
    )
  ) {
    add(
      "unresolved-secrets",
      `Hermes MCP server "${name}" references environment values that were not found in its .env file.`,
      "Define the missing values in OpenClaw's MCP server environment or headers manually.",
    );
  }

  const cert = raw.clientCert ?? raw.client_cert;
  const key = readString(raw.clientKey) ?? readString(raw.client_key);
  if (Array.isArray(cert) && cert.length === 3) {
    add(
      "client-cert-password",
      `Hermes MCP server "${name}" uses a password-protected client key, which OpenClaw cannot represent in MCP config.`,
      "Configure an unencrypted protected key path or an equivalent TLS proxy manually.",
    );
  } else if (
    (cert !== undefined || key !== undefined) &&
    !(
      (Array.isArray(cert) && cert.length === 2 && readString(cert[0]) && readString(cert[1])) ||
      (readString(cert) && key)
    )
  ) {
    add(
      "client-cert",
      `Hermes MCP server "${name}" uses a combined or invalid client-certificate shape that was not imported.`,
      "Configure separate OpenClaw clientCert and clientKey file paths manually.",
    );
  }
  if (typeof (raw.sslVerify ?? raw.ssl_verify) === "string") {
    add(
      "tls-ca",
      `Hermes MCP server "${name}" uses a CA bundle path for TLS verification, which OpenClaw MCP config cannot represent.`,
      "Install the CA in the host trust store or configure an equivalent TLS proxy manually.",
    );
  }

  const transport = readString(raw.transport) ?? readString(raw.type);
  if (transport && !["http", "streamable-http", "sse", "stdio"].includes(transport)) {
    add(
      "transport",
      `Hermes MCP server "${name}" uses unsupported transport "${transport}".`,
      "Configure an equivalent OpenClaw MCP transport manually.",
    );
  }

  const auth = readString(raw.auth);
  if (auth && auth !== "oauth") {
    add(
      "auth",
      `Hermes MCP server "${name}" uses unsupported authentication mode "${auth}".`,
      "Configure an equivalent OpenClaw MCP authentication mode manually.",
    );
  }
  const oauth = isRecord(raw.oauth) ? raw.oauth : undefined;
  if (auth === "oauth" || oauth) {
    add(
      "oauth-login",
      `Hermes MCP server "${name}" requires OAuth login in OpenClaw.`,
      `Run "openclaw mcp login ${name}" after migration.`,
    );
  }
  if (
    oauth &&
    Object.keys(oauth).some(
      (keyName) =>
        !["authProfileId", "scope", "redirectUrl", "clientMetadataUrl"].includes(keyName),
    )
  ) {
    add(
      "oauth-client",
      `Hermes MCP server "${name}" uses pre-registered OAuth client settings that were not copied into OpenClaw config.`,
      `Run "openclaw mcp login ${name}" and configure supported OAuth metadata manually.`,
    );
  }

  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  if (
    tools &&
    (Object.keys(tools).some(
      (keyName) => !["include", "exclude", "resources", "prompts"].includes(keyName),
    ) ||
      (tools.include !== undefined && !readToolFilterList(tools.include)) ||
      (tools.exclude !== undefined && !readToolFilterList(tools.exclude)) ||
      (tools.resources !== undefined && readBooleanish(tools.resources) === undefined) ||
      (tools.prompts !== undefined && readBooleanish(tools.prompts) === undefined))
  ) {
    add(
      "tool-policy",
      `Hermes MCP server "${name}" has a tool policy that cannot be translated exactly.`,
      "Review and configure mcp.servers toolFilter manually.",
    );
  }

  const lifecycle = isRecord(raw.lifecycle) ? raw.lifecycle : {};
  const unsupported = [
    ["preflight", raw.skip_preflight === true],
    ["sampling", isRecord(raw.sampling) && raw.sampling.enabled !== false],
    ["elicitation", isRecord(raw.elicitation) && raw.elicitation.enabled !== false],
    [
      "lifecycle",
      readPositiveNumeric(raw.idle_timeout_seconds ?? lifecycle.idle_timeout_seconds) !==
        undefined ||
        readPositiveNumeric(raw.max_lifetime_seconds ?? lifecycle.max_lifetime_seconds) !==
          undefined,
    ],
    ["keepalive", readPositiveNumeric(raw.keepalive_interval) !== undefined],
  ] as const;
  for (const [feature, configured] of unsupported) {
    if (configured) {
      add(
        feature,
        `Hermes MCP server "${name}" uses ${feature} behavior that OpenClaw MCP config does not expose.`,
        "Review the server requirement and configure an equivalent deployment or runtime policy manually.",
      );
    }
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
