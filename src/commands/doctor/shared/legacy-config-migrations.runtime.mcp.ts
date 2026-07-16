// Legacy MCP runtime config migrations.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
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
    legacyRules: [...MCP_SERVER_DISABLED_RULES, MCP_SERVER_TYPE_RULE],
    apply: (raw, changes) => {
      const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
      migrateMcpServerDisabledFlags(mcp?.servers, "mcp.servers", changes);

      const nodeHost = isRecord(raw.nodeHost) ? raw.nodeHost : undefined;
      const nodeHostMcp = isRecord(nodeHost?.mcp) ? nodeHost.mcp : undefined;
      migrateMcpServerDisabledFlags(nodeHostMcp?.servers, "nodeHost.mcp.servers", changes);

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
