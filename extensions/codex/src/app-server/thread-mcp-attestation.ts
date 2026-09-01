import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export async function attestCodexRestrictedToolSurfaceMcpServersDisabled(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
  threadConfig: JsonObject | undefined,
  signal?: AbortSignal,
  expectedActiveServerNames: readonly string[] = [],
): Promise<void> {
  const configuredServers = threadConfig?.mcp_servers;
  if (configuredServers !== undefined && !isJsonObject(configuredServers)) {
    throw new Error("Codex restricted-tool-surface thread config has invalid mcp_servers");
  }
  // Codex reports configured-but-disabled servers as inactive status rows.
  // Match those rows to the exact per-thread deny patch instead of requiring an empty inventory.
  const expectedDisabledServerNames = new Set<string>();
  for (const [name, serverConfig] of Object.entries(configuredServers ?? {})) {
    if (!isJsonObject(serverConfig) || serverConfig.enabled !== false) {
      throw new Error(`Codex restricted-tool-surface MCP server ${name} is not disabled`);
    }
    expectedDisabledServerNames.add(name);
  }
  const expectedActiveServers = new Set(expectedActiveServerNames);
  for (const name of expectedActiveServers) {
    if (expectedDisabledServerNames.has(name)) {
      throw new Error(`Codex restricted-tool-surface MCP server ${name} has conflicting policy`);
    }
  }
  const response = await client.request(
    "mcpServerStatus/list",
    { threadId, detail: "toolsAndAuthOnly" },
    { signal },
  );
  if (!isJsonObject(response) || !Array.isArray(response.data)) {
    throw new Error(
      "Codex mcpServerStatus/list returned an invalid restricted-tool-surface attestation",
    );
  }
  const observedServerNames = new Set<string>();
  for (const status of response.data) {
    if (!isJsonObject(status) || typeof status.name !== "string" || !isJsonObject(status.tools)) {
      throw new Error(
        "Codex mcpServerStatus/list returned an invalid restricted-tool-surface server",
      );
    }
    if (!expectedDisabledServerNames.has(status.name) && !expectedActiveServers.has(status.name)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found unexpected server ${status.name}`,
      );
    }
    if (observedServerNames.has(status.name)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation returned duplicate server ${status.name}`,
      );
    }
    observedServerNames.add(status.name);
    if (!Object.hasOwn(status, "serverInfo")) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation returned malformed server ${status.name}`,
      );
    }
    if (expectedActiveServers.has(status.name)) {
      if (status.serverInfo === null || Object.keys(status.tools).length === 0) {
        throw new Error(
          `Codex restricted-tool-surface MCP attestation found inactive admitted server ${status.name}`,
        );
      }
      continue;
    }
    if (status.serverInfo !== null) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found active server ${status.name}`,
      );
    }
    if (Object.keys(status.tools).length > 0) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found tools for server ${status.name}`,
      );
    }
  }
  for (const expectedName of expectedDisabledServerNames) {
    if (!observedServerNames.has(expectedName)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation is missing server ${expectedName}`,
      );
    }
  }
  for (const expectedName of expectedActiveServers) {
    if (!observedServerNames.has(expectedName)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation is missing admitted server ${expectedName}`,
      );
    }
  }
  if (response.nextCursor !== undefined && response.nextCursor !== null) {
    throw new Error("Codex mcpServerStatus/list returned an invalid empty-page cursor");
  }
}
