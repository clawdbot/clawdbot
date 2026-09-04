/**
 * Applies host-certified `<server>__*` denies to the Codex MCP projection by
 * disabling those configured servers, the same override `codex.agents` uses.
 */
import { assignMcpCatalogSafeServerNames } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { resolveCodexMcpToolOverridesForAgent } from "openclaw/plugin-sdk/codex-mcp-projection";

type CodexMcpToolOverrides = ReturnType<typeof resolveCodexMcpToolOverridesForAgent>;

export function applyHarnessDeniedMcpServerOverrides(
  overrides: CodexMcpToolOverrides,
  deniedServerNames: readonly string[] | undefined,
): CodexMcpToolOverrides {
  if (!deniedServerNames?.length) {
    return overrides;
  }
  const mcpServers = { ...overrides?.mcpServers };
  for (const serverName of deniedServerNames) {
    // Policy denial narrows session overrides; it never re-enables a server.
    mcpServers[serverName] = false;
  }
  return { ...overrides, mcpServers };
}

/**
 * Native Codex config may define a server under the certified deny's raw key or
 * its sanitized alias in any letter case. Returns the inherited names such a deny
 * covers, so the thread config can switch them off explicitly.
 */
export function resolveDeniedInheritedMcpServerNames(params: {
  inheritedServerNames: readonly string[];
  deniedServerNames: readonly string[] | undefined;
  configuredServerNames: readonly string[];
}): string[] {
  if (!params.deniedServerNames?.length) {
    return [];
  }
  const safeNames = assignMcpCatalogSafeServerNames(params.configuredServerNames);
  const aliases = new Set(
    params.deniedServerNames.flatMap((name) => [
      name.toLowerCase(),
      (safeNames.get(name) ?? name).toLowerCase(),
    ]),
  );
  return [...new Set(params.inheritedServerNames)]
    .filter((name) => aliases.has(name.toLowerCase()))
    .toSorted();
}
