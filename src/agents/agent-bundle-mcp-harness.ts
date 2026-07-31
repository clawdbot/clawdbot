/**
 * Harness-facing materialization of requester-scoped MCP tools.
 * Static MCP stays harness-native; this path never opens static transports.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
} from "./agent-bundle-mcp-runtime.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { AnyAgentTool } from "./tools/common.js";

type RequesterScopedHarnessMcpTools = {
  /** Executable tools for this turn (live binding or not-connected stubs). */
  tools: AnyAgentTool[];
  /**
   * Session-stable advertised tool surface for dynamic-tool fingerprints.
   * Identical for every sender once the session has observed a scoped catalog.
   */
  advertisedTools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

type MaterializeRequesterScopedMcpToolsForHarnessRunParams = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  reservedToolNames?: Iterable<string>;
  toolsAllow?: string[];
  /** When set, applies the same final effective tool policy as the embedded runner. */
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  /** Builds a capability profile when conversationCapabilityProfile is omitted. */
  policyContext?: Omit<ConversationCapabilityProfileParams, "runtimeToolAllowlist">;
  warn?: (message: string) => void;
};

function notConnectedToolResult(serverName: string, toolName: string) {
  const message = `Requester has not connected MCP server "${serverName}" (tool "${toolName}") for this turn.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status: "error" as const,
      error: message,
      mcpServer: serverName,
      mcpTool: toolName,
    },
  };
}

function applyHarnessToolPolicy(
  tools: AnyAgentTool[],
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): AnyAgentTool[] {
  if (tools.length === 0) {
    return tools;
  }
  const allowed = applyEmbeddedAttemptToolsAllow(tools, params.toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const profile =
    params.conversationCapabilityProfile ??
    (params.policyContext
      ? resolveConversationCapabilityProfile({
          ...params.policyContext,
          runtimeToolAllowlist: params.toolsAllow,
        })
      : undefined);
  if (!profile) {
    return allowed;
  }
  return applyFinalEffectiveToolPolicy({
    bundledTools: allowed,
    config: params.policyContext?.config ?? params.cfg,
    conversationCapabilityProfile: profile,
    warn: params.warn ?? (() => undefined),
  });
}

/**
 * Materialize requester-scoped MCP tools for a harness run (e.g. Codex dynamic tools).
 * Updates the session advertised-catalog cache when a requester resolves a catalog.
 * Before any requester resolves in the session, returns undefined (nothing to advertise).
 */
export async function materializeRequesterScopedMcpToolsForHarnessRun(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const scopedRuntime = await getOrCreateRequesterScopedMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    requesterSenderId: params.requesterSenderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
  });

  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  if (scopedRuntime) {
    liveRuntime = await materializeBundleMcpToolsForRun({
      runtime: scopedRuntime,
      reservedToolNames: params.reservedToolNames,
    });
    const catalog = scopedRuntime.peekCatalog() ?? (await scopedRuntime.getCatalog());
    rememberAdvertisedScopedMcpCatalog(params.sessionId, catalog);
  }

  const advertisedCatalog = getAdvertisedScopedMcpCatalog(params.sessionId);
  if (!advertisedCatalog || advertisedCatalog.tools.length === 0) {
    await liveRuntime?.dispose();
    return undefined;
  }

  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;
  const advertisedTools = buildBundleMcpToolsFromCatalog({
    catalog: advertisedCatalog,
    reservedToolNames,
    createExecute: (tool) => async () => notConnectedToolResult(tool.serverName, tool.toolName),
  });
  const liveByName = new Map((liveRuntime?.tools ?? []).map((tool) => [tool.name, tool]));
  // Live tools supply execution; advertised catalog supplies the stable name/schema surface.
  const tools = advertisedTools.map((tool) => liveByName.get(tool.name) ?? tool);

  const filteredTools = applyHarnessToolPolicy(tools, params);
  const filteredAdvertised = applyHarnessToolPolicy(advertisedTools, params);
  // Policy must keep both lists aligned by name for fingerprint stability.
  const allowedNames = new Set(filteredAdvertised.map((tool) => tool.name));
  const executableTools = filteredTools.filter((tool) => allowedNames.has(tool.name));

  let disposed = false;
  return {
    tools: executableTools,
    advertisedTools: filteredAdvertised,
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      await liveRuntime?.dispose();
    },
  };
}
