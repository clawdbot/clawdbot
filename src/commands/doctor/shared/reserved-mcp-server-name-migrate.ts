// Removes MCP server entries whose names are reserved by config validation.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord, type JsonRecord } from "./legacy-config-record-shared.js";

const RESERVED_MCP_SERVER_NAME = "__proto__";

function resolveMcpServers(raw: unknown, nodeHost: boolean): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const owner = nodeHost ? raw.nodeHost : raw;
  if (!isRecord(owner)) {
    return undefined;
  }
  const mcp = isRecord(owner.mcp) ? owner.mcp : undefined;
  return isRecord(mcp?.servers) ? mcp.servers : undefined;
}

/** Drop reserved MCP server names before canonical config validation runs. */
export function migrateReservedMcpServerNames(
  cfg: OpenClawConfig,
  sourceRaw: unknown = cfg,
): {
  config: OpenClawConfig;
  changes: string[];
} {
  const locations = [
    { path: "mcp.servers", nodeHost: false },
    { path: "nodeHost.mcp.servers", nodeHost: true },
  ].filter(({ nodeHost }) =>
    [sourceRaw, cfg].some((value) =>
      Object.hasOwn(resolveMcpServers(value, nodeHost) ?? {}, RESERVED_MCP_SERVER_NAME),
    ),
  );
  if (locations.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];
  for (const { path, nodeHost } of locations) {
    const servers = resolveMcpServers(next, nodeHost);
    if (servers) {
      delete servers[RESERVED_MCP_SERVER_NAME];
    }
    changes.push(
      `Dropped MCP server "${RESERVED_MCP_SERVER_NAME}" from ${path} because the name is reserved; re-add it under a different name.`,
    );
  }
  return { config: next, changes };
}
