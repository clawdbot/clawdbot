/** Projects the canonical conversation tool policy into raw native MCP identities. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpConfig } from "../plugins/bundle-mcp.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-materialize.js";
import type {
  McpToolCatalog,
  PreparedNativeMcpPolicy,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { isRecord } from "./bundle-mcp-adapter.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";

function buildPolicyProjectionTools(catalog: McpToolCatalog) {
  // Callable names are policy identities. Reserve them before hidden inventory
  // so catalog-only rows cannot retarget an existing allow or deny entry.
  const callableTools = buildBundleMcpToolsFromCatalog({ catalog }).filter(
    (tool) => getPluginToolMeta(tool)?.mcp?.operation === "tool",
  );
  const callableIdentities = new Set(
    callableTools.flatMap((tool) => {
      const mcp = getPluginToolMeta(tool)?.mcp;
      return mcp?.operation === "tool" ? [JSON.stringify([mcp.serverName, mcp.toolName])] : [];
    }),
  );
  const policyTools = catalog.policyTools ?? [
    ...catalog.tools,
    ...(catalog.sessionDeniedTools ?? []),
  ];
  const hiddenPolicyTools = policyTools.filter(
    (tool) => !callableIdentities.has(JSON.stringify([tool.serverName, tool.toolName])),
  );
  const hiddenTools = buildBundleMcpToolsFromCatalog({
    catalog: {
      ...catalog,
      tools: hiddenPolicyTools,
      policyTools: undefined,
      sessionDeniedTools: undefined,
    },
    reservedToolNames: callableTools.map((tool) => tool.name),
    includeAppOnlyInventory: true,
  }).filter((tool) => getPluginToolMeta(tool)?.mcp?.operation === "tool");
  return [...callableTools, ...hiddenTools];
}

export async function prepareNativeMcpPolicy(params: {
  runtime: SessionMcpRuntime;
  config?: OpenClawConfig;
  workspaceDir: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  runtimeToolsAllow?: string[];
  warn: (message: string) => void;
}): Promise<PreparedNativeMcpPolicy> {
  params.runtime.markUsed();
  const catalog = await params.runtime.getCatalog();
  const allTools = buildPolicyProjectionTools(catalog);
  const runtimeAllowed = applyEmbeddedAttemptToolsAllow(allTools, params.runtimeToolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const effectiveAllowed = applyFinalEffectiveToolPolicy({
    bundledTools: runtimeAllowed,
    config: params.config,
    workspaceDir: params.workspaceDir,
    conversationCapabilityProfile: params.capabilityProfile,
    warn: params.warn,
  });
  const effectiveAllowedNames = new Set(effectiveAllowed.map((tool) => tool.name));
  const servers: PreparedNativeMcpPolicy["servers"] = {};

  for (const tool of allTools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (!mcp || mcp.operation !== "tool") {
      continue;
    }
    const server = (servers[mcp.serverName] ??= {
      serverName: mcp.serverName,
      safeServerName: mcp.safeServerName,
      allowedTools: [],
      deniedTools: [],
    });
    const allowed =
      !mcp.excludedFromOpenClawCatalog &&
      !mcp.deniedBySession &&
      effectiveAllowedNames.has(tool.name);
    (allowed ? server.allowedTools : server.deniedTools).push(mcp.toolName);
  }

  for (const server of Object.values(servers)) {
    server.allowedTools = [...new Set(server.allowedTools)].toSorted();
    server.deniedTools = [...new Set(server.deniedTools)].toSorted();
  }
  return {
    servers: Object.fromEntries(
      Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/** Applies one prepared policy to the provider-neutral MCP config shape. */
export function applyPreparedNativeMcpPolicy(
  config: BundleMcpConfig,
  policy: PreparedNativeMcpPolicy,
): BundleMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(config.mcpServers).flatMap(([serverName, server]) => {
        const prepared = policy.servers[serverName];
        if (!prepared || prepared.allowedTools.length === 0) {
          return [];
        }
        const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
        return [
          [
            serverName,
            {
              ...server,
              toolFilter: {
                ...toolFilter,
                include: prepared.allowedTools,
                exclude: prepared.deniedTools,
              },
            },
          ],
        ];
      }),
    ),
  };
}

/** Returns raw per-server denials for backends that enforce a deny list. */
export function preparedNativeMcpDenials(
  policy: PreparedNativeMcpPolicy,
): Record<string, string[]> | undefined {
  const entries = Object.values(policy.servers)
    .filter((server) => server.deniedTools.length > 0)
    .map((server) => [server.serverName, server.deniedTools] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
