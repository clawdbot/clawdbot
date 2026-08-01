/**
 * Harness-facing materialization of requester-scoped MCP tools.
 * Static MCP stays harness-native by default; on a scoped-allowlist turn the
 * caller may pass `staticServerNames` to expose those named static servers as
 * dynamic tools instead (per-turn only, never written to the session cache).
 */
import type { SessionToolOverrides } from "../config/sessions/types.js";
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
  getOrCreateStaticScopedMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
} from "./agent-bundle-mcp-runtime.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-types.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { selectAllowlistedStaticMcpServerNames } from "./mcp-allowlist-server-select.js";
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
  /**
   * Scoped-allowlist turns: also expose the static servers the `toolsAllow`
   * references as dynamic tools. They are materialized live from their own
   * catalog and merged for this turn only — never remembered in the session
   * advertised cache, so a later wildcard turn (where they return to native
   * attachment) sees no stale stub. No-op when `toolsAllow` is unrestricted.
   */
  exposeAllowlistedStaticServers?: boolean;
  toolsAllow?: string[];
  /** Owning agent of the turn; gates servers declaring `codex.agents`. */
  agentId?: string;
  /** Session overrides that disable a server or deny its tools for this session. */
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
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
 * Materialize requester-scoped (and, on a scoped turn, named static) MCP tools
 * for a harness run (e.g. Codex dynamic tools). Requester-scoped servers update
 * the session advertised-catalog cache so specs stay stable per sender; static
 * servers are materialized live for this turn only and are NOT cached. Returns
 * undefined when neither surface has anything to advertise.
 */
export async function materializeRequesterScopedMcpToolsForHarnessRun(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;

  // Requester-scoped: session-cached advertised surface (identical per sender).
  // `toolOverrides` is deliberately not forwarded here: this path never carried
  // them, and starting to would change which requester-scoped servers a session
  // reaches — a separate behaviour change from restoring the static ones. The
  // static branch below needs them because it takes over servers the native
  // projection (which does honor them) stops projecting for the turn.
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
      reservedToolNames,
    });
    const catalog = scopedRuntime.peekCatalog() ?? (await scopedRuntime.getCatalog());
    rememberAdvertisedScopedMcpCatalog(params.sessionId, catalog);
  }
  const requesterAdvertisedCatalog = getAdvertisedScopedMcpCatalog(params.sessionId);

  // Static-scoped: live catalog drives the advertised specs directly, for this
  // turn only. Static server names are sender-independent, so the live catalog
  // is already session-stable; keeping it out of the session cache is what
  // prevents a later wildcard turn from inheriting a stale not-connected stub.
  let staticLiveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let staticAdvertisedCatalog: McpToolCatalog | undefined;
  const staticServerNames = params.exposeAllowlistedStaticServers
    ? selectAllowlistedStaticMcpServerNames({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        manifestRegistry: params.manifestRegistry,
        toolsAllow: params.toolsAllow,
        agentId: params.agentId,
        toolOverrides: params.toolOverrides,
      })
    : undefined;
  if (staticServerNames && staticServerNames.size > 0) {
    const staticRuntime = await getOrCreateStaticScopedMcpRuntime({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: staticServerNames,
      toolOverrides: params.toolOverrides,
    });
    if (staticRuntime) {
      staticLiveRuntime = await materializeBundleMcpToolsForRun({
        runtime: staticRuntime,
        reservedToolNames,
      });
      staticAdvertisedCatalog = staticRuntime.peekCatalog() ?? (await staticRuntime.getCatalog());
    }
  }

  const buildNotConnected = (catalog: McpToolCatalog) =>
    buildBundleMcpToolsFromCatalog({
      catalog,
      reservedToolNames,
      createExecute: (tool) => async () => notConnectedToolResult(tool.serverName, tool.toolName),
    });
  const advertisedTools: AnyAgentTool[] = [];
  if (requesterAdvertisedCatalog && requesterAdvertisedCatalog.tools.length > 0) {
    advertisedTools.push(...buildNotConnected(requesterAdvertisedCatalog));
  }
  if (staticAdvertisedCatalog && staticAdvertisedCatalog.tools.length > 0) {
    advertisedTools.push(...buildNotConnected(staticAdvertisedCatalog));
  }
  if (advertisedTools.length === 0) {
    await liveRuntime?.dispose();
    await staticLiveRuntime?.dispose();
    return undefined;
  }
  const liveByName = new Map(
    [...(liveRuntime?.tools ?? []), ...(staticLiveRuntime?.tools ?? [])].map((tool) => [
      tool.name,
      tool,
    ]),
  );
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
      await staticLiveRuntime?.dispose();
    },
  };
}
