import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers, unsetConfiguredMcpServer } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { ClawRemoveError } from "./lifecycle-delete-support.js";
import type { RemovedMcpServer } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import { deleteClawMcpServerRef, digestClawMcpServer, planClawMcpServerRemoval } from "./mcp.js";
import type { ClawReferencedCleanup } from "./package-remove.js";

type RemoveMcpServerOptions = OpenClawStateDatabaseOptions & {
  config?: OpenClawConfig;
  sourceMcpServers?: Record<string, Record<string, unknown>>;
  listMcpServers?: typeof listConfiguredMcpServers;
  referencedCleanup?: ClawReferencedCleanup;
  unsetMcpServer?: typeof unsetConfiguredMcpServer;
};

export async function removeClawMcpServers(params: {
  agentId: string;
  servers: ClawStatusRecord["mcpServers"];
  options: RemoveMcpServerOptions;
}): Promise<{ mcpServers: RemovedMcpServer[]; error?: string }> {
  const listed = params.options.sourceMcpServers
    ? undefined
    : params.options.listMcpServers
      ? await params.options.listMcpServers()
      : params.options.config
        ? undefined
        : await listConfiguredMcpServers();
  if (listed && !listed.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listed.error);
  }
  const configured = listed?.ok
    ? listed.mcpServers
    : normalizeConfiguredMcpServers(
        params.options.sourceMcpServers ?? params.options.config?.mcp?.servers,
      );
  const unsetMcpServer = params.options.unsetMcpServer ?? unsetConfiguredMcpServer;
  const mcpServers: RemovedMcpServer[] = [];
  for (const server of params.servers) {
    const ownerAction = planClawMcpServerRemoval(server, params.options).action;
    if (ownerAction === "release") {
      deleteClawMcpServerRef(params.agentId, server.name, params.options);
      mcpServers.push({
        name: server.name,
        action: server.state === "missing" ? "missing" : "released",
      });
      continue;
    }
    const expectedServer = configured[server.name];
    if (!expectedServer) {
      if (server.state === "present") {
        throw new ClawRemoveError(
          "mcp_cleanup_changed",
          `MCP server ${JSON.stringify(server.name)} disappeared during removal.`,
        );
      }
      deleteClawMcpServerRef(params.agentId, server.name, params.options);
      mcpServers.push({ name: server.name, action: "missing" });
      continue;
    }
    if (digestClawMcpServer(expectedServer) !== server.configDigest) {
      throw new ClawRemoveError(
        "mcp_cleanup_changed",
        `MCP server ${JSON.stringify(server.name)} changed during removal.`,
      );
    }
    try {
      const result = await unsetMcpServer({ name: server.name, expectedServer });
      if (!result.ok) {
        throw new Error(result.error);
      }
      deleteClawMcpServerRef(params.agentId, server.name, params.options);
      mcpServers.push({ name: server.name, action: result.removed ? "removed" : "missing" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mcpServers.push({ name: server.name, action: "error", message });
      return { mcpServers, error: message };
    }
  }
  return { mcpServers };
}
