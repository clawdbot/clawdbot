/** Projects the canonical conversation tool policy into raw native MCP identities. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpConfig } from "../plugins/bundle-mcp.js";
import { getPluginToolMeta } from "../plugins/tools.js";
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
import { normalizeToolName } from "./tool-policy.js";

/** True when canonical conversation policy needs a concrete native MCP catalog. */
export function requiresPreparedNativeMcpPolicy(params: {
  capabilityProfile: ResolvedConversationCapabilityProfile;
  runtimeToolsAllow?: string[];
  mcpServers?: BundleMcpConfig["mcpServers"];
}): boolean {
  if (params.runtimeToolsAllow !== undefined) {
    return true;
  }
  if (
    Object.values(params.mcpServers ?? {}).some((server) => {
      const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : undefined;
      return Array.isArray(toolFilter?.include) || Array.isArray(toolFilter?.exclude);
    })
  ) {
    return true;
  }
  const policy = params.capabilityProfile.policy;
  return (
    policy.explicitToolDenylist.length > 0 ||
    policy.explicitToolAllowlist.some((entry) => normalizeToolName(entry) !== "*")
  );
}

function buildPolicyProjectionCatalog(catalog: McpToolCatalog): McpToolCatalog {
  const policyTools = catalog.policyTools ?? [
    ...catalog.tools,
    ...(catalog.sessionDeniedTools ?? []),
  ];
  return {
    ...catalog,
    // Native clients can expose every raw MCP tool, including App-only tools.
    // Remove only presentation visibility while assigning canonical safe names.
    tools: policyTools.map(({ uiVisibility: _uiVisibility, ...tool }) => tool),
    sessionDeniedTools: undefined,
  };
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
  const policyCatalog = buildPolicyProjectionCatalog(catalog);
  const allTools = buildBundleMcpToolsFromCatalog({ catalog: policyCatalog });
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
    const excludedBy: Array<"configured-filter" | "session-override" | "effective-policy"> = [];
    if (mcp.excludedByConfiguredFilter) {
      excludedBy.push("configured-filter");
    }
    if (mcp.deniedBySession) {
      excludedBy.push("session-override");
    }
    if (!effectiveAllowedNames.has(tool.name)) {
      excludedBy.push("effective-policy");
    }
    const server = (servers[mcp.serverName] ??= {
      serverName: mcp.serverName,
      safeServerName: mcp.safeServerName,
      allowedTools: [],
      deniedTools: [],
      tools: [],
    });
    const allowed = excludedBy.length === 0;
    (allowed ? server.allowedTools : server.deniedTools).push(mcp.toolName);
    server.tools.push({ rawName: mcp.toolName, safeName: tool.name, allowed, excludedBy });
  }

  for (const server of Object.values(servers)) {
    server.allowedTools = [...new Set(server.allowedTools)].toSorted();
    server.deniedTools = [...new Set(server.deniedTools)].toSorted();
    server.tools.sort((left, right) => left.safeName.localeCompare(right.safeName));
  }
  return {
    servers: Object.fromEntries(
      Object.entries(servers).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    diagnostics: catalog.diagnostics ?? [],
  };
}
