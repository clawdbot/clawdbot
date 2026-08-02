// Legacy MCP runtime config migrations.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  canonicalizeConfiguredMcpServer,
  isKnownCliMcpTypeAlias,
  resolveOpenClawMcpTransportAlias,
} from "../../../config/mcp-config-normalize.js";
import { isRecord } from "./legacy-config-record-shared.js";

const MCP_SERVER_TYPE_RULE: LegacyConfigRule = {
  path: ["mcp", "servers"],
  message:
    'mcp.servers entries use OpenClaw transport names; CLI-native type aliases are legacy here. Run "openclaw doctor --fix".',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && isKnownCliMcpTypeAlias(server.type)),
};

const MCP_SERVER_DISABLED_RULES: LegacyConfigRule[] = [
  ["mcp", "servers"],
  ["nodeHost", "mcp", "servers"],
].map((path) => ({
  path,
  message:
    `${path.join(".")} entries use the unsupported "disabled" key; use "enabled" with the inverse boolean value. ` +
    'Run "openclaw doctor --fix" to migrate it.',
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && typeof server.disabled === "boolean"),
}));

const MCP_SERVER_TIMEOUT_ALIASES_RULES: LegacyConfigRule[] = [
  ["mcp", "servers"],
  ["nodeHost", "mcp", "servers"],
].map((path) => ({
  path,
  message: `${path.join(".")} timeout aliases were retired; use connectionTimeoutMs and requestTimeoutMs. Run "openclaw doctor --fix".`,
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some(
      (server) =>
        isRecord(server) &&
        ["connectTimeout", "connect_timeout", "timeout"].some((key) => Object.hasOwn(server, key)),
    ),
}));

function hasMcpServerLegacyAliases(server: Record<string, unknown>): boolean {
  const codex = isRecord(server.codex) ? server.codex : undefined;
  return (
    Object.hasOwn(server, "workingDirectory") ||
    ["supports_parallel_tool_calls", "ssl_verify", "client_cert", "client_key"].some((key) =>
      Object.hasOwn(server, key),
    ) ||
    Boolean(codex && Object.hasOwn(codex, "default_tools_approval_mode"))
  );
}

const MCP_SERVER_ALIASES_RULES: LegacyConfigRule[] = [
  ["mcp", "servers"],
  ["nodeHost", "mcp", "servers"],
].map((path) => ({
  path,
  message: `${path.join(".")} legacy aliases were retired; use camelCase spellings and cwd. Run "openclaw doctor --fix".`,
  match: (value) =>
    isRecord(value) &&
    Object.values(value).some((server) => isRecord(server) && hasMcpServerLegacyAliases(server)),
}));

function migrateMcpServerAliases(servers: unknown, pathPrefix: string, changes: string[]): void {
  if (!isRecord(servers)) {
    return;
  }
  for (const [serverName, value] of Object.entries(servers)) {
    if (!isRecord(value)) {
      continue;
    }
    if (!hasMcpServerLegacyAliases(value)) {
      continue;
    }
    const normalized = canonicalizeConfiguredMcpServer(value);
    if (JSON.stringify(normalized) === JSON.stringify(value)) {
      continue;
    }
    servers[serverName] = normalized;
    changes.push(`Canonicalized legacy aliases in ${pathPrefix}.${serverName}.`);
  }
}

function migrateMcpServerTimeoutAliases(
  servers: unknown,
  pathPrefix: string,
  changes: string[],
): void {
  if (!isRecord(servers)) {
    return;
  }
  for (const [serverName, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      continue;
    }
    for (const [alias, canonical] of [
      ["connectTimeout", "connectionTimeoutMs"],
      ["connect_timeout", "connectionTimeoutMs"],
      ["timeout", "requestTimeoutMs"],
    ] as const) {
      if (!Object.hasOwn(server, alias)) {
        continue;
      }
      const value = server[alias];
      // Old runtime only honored positive alias seconds; canonical fields are
      // finite().positive(), so migrating 0/negative/overflow would fail validation.
      if (
        server[canonical] === undefined &&
        typeof value === "number" &&
        value > 0 &&
        Number.isFinite(value * 1_000)
      ) {
        server[canonical] = value * 1_000;
        changes.push(
          `Moved ${pathPrefix}.${serverName}.${alias} → ${canonical} (${value * 1_000} ms).`,
        );
      } else {
        changes.push(
          `Removed ${pathPrefix}.${serverName}.${alias} (${canonical} already set or alias invalid).`,
        );
      }
      delete server[alias];
    }
  }
}

function migrateMcpServerDisabledFlags(
  servers: unknown,
  pathPrefix: string,
  changes: string[],
): void {
  if (!isRecord(servers)) {
    return;
  }

  for (const [serverName, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer) || typeof rawServer.disabled !== "boolean") {
      continue;
    }
    const disabled = rawServer.disabled;
    if (typeof rawServer.enabled !== "boolean") {
      rawServer.enabled = !disabled;
      changes.push(
        `Moved ${pathPrefix}.${serverName}.disabled ${disabled} → enabled ${!disabled}.`,
      );
    } else {
      changes.push(
        `Removed ${pathPrefix}.${serverName}.disabled ${disabled} because enabled is already set to ${rawServer.enabled}.`,
      );
    }
    delete rawServer.disabled;
  }
}

/** Legacy config migration specs for MCP server config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "mcp.servers.canonicalize",
    describe: "Normalize legacy MCP server config",
    legacyRules: [
      ...MCP_SERVER_DISABLED_RULES,
      MCP_SERVER_TYPE_RULE,
      ...MCP_SERVER_TIMEOUT_ALIASES_RULES,
      ...MCP_SERVER_ALIASES_RULES,
    ],
    apply: (raw, changes) => {
      const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
      migrateMcpServerDisabledFlags(mcp?.servers, "mcp.servers", changes);
      migrateMcpServerTimeoutAliases(mcp?.servers, "mcp.servers", changes);
      migrateMcpServerAliases(mcp?.servers, "mcp.servers", changes);

      const nodeHost = isRecord(raw.nodeHost) ? raw.nodeHost : undefined;
      const nodeHostMcp = isRecord(nodeHost?.mcp) ? nodeHost.mcp : undefined;
      migrateMcpServerDisabledFlags(nodeHostMcp?.servers, "nodeHost.mcp.servers", changes);
      migrateMcpServerTimeoutAliases(nodeHostMcp?.servers, "nodeHost.mcp.servers", changes);
      migrateMcpServerAliases(nodeHostMcp?.servers, "nodeHost.mcp.servers", changes);

      const servers = isRecord(mcp?.servers) ? mcp?.servers : undefined;
      if (!servers) {
        return;
      }

      for (const [serverName, rawServer] of Object.entries(servers)) {
        if (!isRecord(rawServer) || !isKnownCliMcpTypeAlias(rawServer.type)) {
          continue;
        }
        const rawType = typeof rawServer.type === "string" ? rawServer.type : "";
        const alias = resolveOpenClawMcpTransportAlias(rawServer.type);
        if (typeof rawServer.transport !== "string" && alias) {
          rawServer.transport = alias;
          changes.push(`Moved mcp.servers.${serverName}.type "${rawType}" → transport "${alias}".`);
        } else if (typeof rawServer.transport === "string") {
          changes.push(
            `Removed mcp.servers.${serverName}.type (transport "${rawServer.transport}" already set).`,
          );
        } else {
          changes.push(`Removed mcp.servers.${serverName}.type "${rawType}".`);
        }
        delete rawServer.type;
      }
    },
  }),
];
