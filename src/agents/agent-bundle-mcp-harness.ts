/** Harness-facing materialization of configured MCP tools. */
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { mergeMcpConnectCatalog } from "./agent-bundle-mcp-requester-connect.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  retireSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime.js";
import type { McpToolCatalog, RequesterMcpConnect } from "./agent-bundle-mcp-types.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { requiresMcpCodexToolApproval } from "./mcp-codex-tool-approval.js";
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

type ScheduledStaticHarnessMcpTools = {
  /** Final executable static MCP tools for this scheduled turn. */
  tools: AnyAgentTool[];
  /** Bounded model/operator warning when configured servers or final policy were incomplete. */
  diagnosticNotice?: string;
  dispose: () => Promise<void>;
};

function formatScheduledMcpDiagnosticNotice(messages: readonly string[]): string | undefined {
  const bounded = [...new Set(messages)]
    .map((message) => message.replaceAll(/\s+/g, " ").trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, 4);
  if (bounded.length === 0) {
    return undefined;
  }
  return (
    `Configured MCP is incomplete for this scheduled run: ${bounded.join("; ")}. ` +
    "Do not claim MCP-backed work succeeded; report this blocker to the operator."
  );
}

function isScheduledCodexApprovalAllowed(tool: AnyAgentTool, autoApprove: boolean): boolean {
  const mcp = getPluginToolMeta(tool)?.mcp;
  return (
    mcp?.operation !== "tool" ||
    autoApprove ||
    (mcp.codexApproval !== undefined && !requiresMcpCodexToolApproval(mcp.codexApproval))
  );
}

function filterScheduledCodexApproval(
  tools: readonly AnyAgentTool[],
  autoApprove: boolean,
  onOmitted?: (message: string) => void,
): AnyAgentTool[] {
  return tools.filter((tool) => {
    if (isScheduledCodexApprovalAllowed(tool, autoApprove)) {
      return true;
    }
    const mcp = getPluginToolMeta(tool)?.mcp;
    onOmitted?.(
      `${mcp?.serverName ?? "configured MCP"}/${mcp?.toolName ?? tool.name}: requires interactive Codex approval (${mcp?.codexApproval?.mode ?? "auto"}); configure codex.defaultToolsApprovalMode="approve" or use the host-confirmed yolo profile`,
    );
    return false;
  });
}

type MaterializeRequesterScopedMcpToolsForHarnessRunParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
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

function buildCatalogTools(
  catalog: McpToolCatalog,
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
  requesterConnect?: RequesterMcpConnect,
): AnyAgentTool[] {
  return buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames: params.reservedToolNames ? Array.from(params.reservedToolNames) : undefined,
    createExecute: (tool) => {
      return (
        requesterConnect?.createExecute(tool.serverName) ??
        (async () => notConnectedToolResult(tool.serverName, tool.toolName))
      );
    },
  });
}

/**
 * Materialize only static configured MCP for an authenticated scheduled turn.
 * No requester identity is accepted here, so requester resolvers stay unreachable.
 */
export async function materializeStaticMcpToolsForScheduledHarnessRunCore(
  params: Omit<
    MaterializeRequesterScopedMcpToolsForHarnessRunParams,
    "requesterSenderId" | "agentAccountId" | "messageChannel"
  > & {
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
    /** Exact established Codex yolo predicate; no other profile bypasses approval metadata. */
    autoApproveCodexAppServerApprovals?: boolean;
    /** Mutation-only probes retire their isolated runtime after the snapshot. */
    retireSessionRuntimeAfterDispose?: boolean;
  },
): Promise<ScheduledStaticHarnessMcpTools> {
  const runtime = await getOrCreateSessionMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    toolOverrides: params.toolOverrides,
  });
  const retireSnapshotRuntime = params.retireSessionRuntimeAfterDispose
    ? async () => {
        await retireSessionMcpRuntime({
          sessionId: params.sessionId,
          reason: "scheduled-authority-snapshot-complete",
        });
      }
    : undefined;
  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>;
  try {
    liveRuntime = await materializeBundleMcpToolsForRun({
      runtime,
      agentId: params.agentId,
      reservedToolNames: params.reservedToolNames,
      ...(retireSnapshotRuntime ? { disposeRuntime: retireSnapshotRuntime } : {}),
    });
  } catch (error) {
    await retireSnapshotRuntime?.();
    throw error;
  }
  try {
    const policyWarnings: string[] = [];
    const policyParams = {
      ...params,
      warn: (message: string) => {
        policyWarnings.push(message);
        params.warn?.(message);
      },
    };
    const allowed = filterScheduledCodexApproval(
      applyHarnessToolPolicy(liveRuntime.tools, policyParams),
      params.autoApproveCodexAppServerApprovals === true,
      (message) => policyWarnings.push(message),
    );
    // App views outlive this attempt, so bind their callable surface to the
    // same complete catalog and final policy before any model tool can mint one.
    liveRuntime.restrictAppTools?.(
      filterScheduledCodexApproval(
        applyHarnessToolPolicy(liveRuntime.appTools ?? liveRuntime.tools, policyParams),
        params.autoApproveCodexAppServerApprovals === true,
        (message) => policyWarnings.push(message),
      ),
    );
    const diagnosticNotice = formatScheduledMcpDiagnosticNotice([
      ...(liveRuntime.diagnostics ?? []).map(
        (diagnostic) => `${diagnostic.serverName}: ${diagnostic.message}`,
      ),
      ...policyWarnings,
    ]);
    let disposed = false;
    return {
      tools: allowed,
      ...(diagnosticNotice ? { diagnosticNotice } : {}),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await liveRuntime.dispose();
      },
    };
  } catch (error) {
    await liveRuntime.dispose();
    throw error;
  }
}

/**
 * Materialize requester-scoped MCP tools for a harness run (e.g. Codex dynamic tools).
 * Updates the session advertised-catalog cache when a requester resolves a catalog.
 * Before any requester resolves in the session, returns undefined (nothing to advertise).
 */
export async function materializeRequesterScopedMcpToolsForHarnessRunCore(
  params: MaterializeRequesterScopedMcpToolsForHarnessRunParams,
): Promise<RequesterScopedHarnessMcpTools | undefined> {
  const scopedRuntime = await getOrCreateRequesterScopedMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    toolOverrides: params.toolOverrides,
    requesterSenderId: params.requesterSenderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
  });

  let liveRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let liveCatalog: McpToolCatalog | undefined;
  try {
    if (scopedRuntime) {
      liveRuntime = await materializeBundleMcpToolsForRun({
        runtime: scopedRuntime,
        agentId: params.agentId,
        reservedToolNames: params.reservedToolNames,
      });
      liveCatalog = scopedRuntime.peekCatalog() ?? (await scopedRuntime.getCatalog());
      if (liveCatalog.tools.length > 0) {
        rememberAdvertisedScopedMcpCatalog(params.sessionId, liveCatalog);
      }
    }

    const advertisedCatalog =
      getAdvertisedScopedMcpCatalog(params.sessionId) ??
      (liveCatalog
        ? mergeMcpConnectCatalog(liveCatalog, scopedRuntime?.requesterConnect)
        : undefined);
    if (!advertisedCatalog || advertisedCatalog.tools.length === 0) {
      await liveRuntime?.dispose();
      return undefined;
    }

    const reservedToolNames = params.reservedToolNames
      ? Array.from(params.reservedToolNames)
      : undefined;
    const advertisedTools = buildCatalogTools(
      advertisedCatalog,
      { ...params, reservedToolNames },
      scopedRuntime?.requesterConnect,
    );
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
  } catch (error) {
    await liveRuntime?.dispose();
    throw error;
  }
}
