/** Harness-facing materialization of configured MCP tools. */
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  retireSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import {
  buildBundleMcpToolsFromCatalog,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import { mergeMcpConnectCatalog } from "./agent-bundle-mcp-requester-connect.js";
import type { McpToolCatalog, RequesterMcpConnect } from "./agent-bundle-mcp-types.js";
import type { CodexMcpServersConfig } from "./codex-mcp-config.types.js";
import {
  resolveConversationCapabilityProfile,
  type ConversationCapabilityProfileParams,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "./embedded-agent-runner/effective-tool-policy.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  formatMcpCodexApprovalRemedy,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "./mcp-codex-tool-approval.js";
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

type StaticHarnessMcpTools = {
  /** Final executable static MCP tools for this turn. */
  tools: AnyAgentTool[];
  /** Bounded model/operator warning when configured servers or final policy were incomplete. */
  diagnosticNotice?: string;
  dispose: () => Promise<void>;
};

function formatConfiguredMcpDiagnosticNotice(
  messages: readonly string[],
  runLabel: "this scheduled run" | "this run",
): string | undefined {
  const bounded = [...new Set(messages)]
    .map((message) => message.replaceAll(/\s+/g, " ").trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, 4);
  if (bounded.length === 0) {
    return undefined;
  }
  return (
    `Configured MCP is incomplete for ${runLabel}: ${bounded.join("; ")}. ` +
    "Do not claim MCP-backed work succeeded; report this blocker to the operator."
  );
}

type InteractiveConfiguredMcpApprovalRequest = {
  signal?: AbortSignal;
  safeToolName: string;
  toolCallId: string;
  serverName: string;
  toolName: string;
  mode: "auto" | "prompt";
  isActive: () => boolean;
};

function applyConfiguredMcpApproval(
  tools: readonly AnyAgentTool[],
  options: {
    fullPermission: boolean;
    projectedMcpServers?: CodexMcpServersConfig;
    requestApproval?: (params: InteractiveConfiguredMcpApprovalRequest) => Promise<void>;
    onOmitted?: (message: string) => void;
  },
): AnyAgentTool[] {
  return tools.flatMap((tool) => {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (mcp?.operation !== "tool") {
      return [tool];
    }
    const projectedMode = resolveProjectedMcpCodexToolApprovalMode(
      mcp.serverName,
      {},
      options.projectedMcpServers?.[mcp.serverName],
      mcp.toolName,
    );
    const mode = projectedMode ?? mcp.codexApproval?.mode;
    if (
      !requiresMcpCodexToolApproval({
        ...mcp.codexApproval,
        mode,
        fullPermission: options.fullPermission,
      })
    ) {
      return [tool];
    }
    const approvalMode = mode === "prompt" ? "prompt" : "auto";
    const requestApproval = options.requestApproval;
    if (!requestApproval) {
      options.onOmitted?.(
        `${mcp.serverName}/${mcp.toolName}: requires interactive Codex approval (${approvalMode}); ${formatMcpCodexApprovalRemedy(mcp.serverName)}`,
      );
      return [];
    }
    const meta = getPluginToolMeta(tool)!;
    const execute = tool.execute;
    const guarded = {
      ...tool,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: Parameters<AnyAgentTool["execute"]>[3],
      ) => {
        // Dynamic tools bypass Codex's native MCP gate. Keep the exact call live
        // while host approval is pending, then run its original executor once.
        let active = true;
        try {
          await requestApproval({
            signal,
            safeToolName: tool.name,
            toolCallId,
            serverName: mcp.serverName,
            toolName: mcp.toolName,
            mode: approvalMode,
            isActive: () => active,
          });
          return await execute(toolCallId, params, signal, onUpdate);
        } finally {
          active = false;
        }
      },
    } satisfies AnyAgentTool;
    setPluginToolMeta(guarded, meta);
    return [guarded];
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
 * Materialize static configured MCP for a Codex harness turn.
 * No requester identity is accepted here, so requester resolvers stay unreachable.
 */
export async function materializeStaticMcpToolsForHarnessRunCore(
  params: Omit<
    MaterializeRequesterScopedMcpToolsForHarnessRunParams,
    "requesterSenderId" | "agentAccountId" | "messageChannel"
  > & {
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
    /** Exact established Codex yolo predicate; no other profile bypasses approval metadata. */
    autoApproveCodexAppServerApprovals?: boolean;
    /** Prepared native projection carries exact persisted per-tool approval grants. */
    projectedMcpServers?: CodexMcpServersConfig;
    /** Interactive turns request approval before the original MCP executor runs. */
    requestInteractiveCodexApproval?: (
      params: InteractiveConfiguredMcpApprovalRequest,
    ) => Promise<void>;
    /** Mutation-only probes retire their isolated runtime after the snapshot. */
    retireSessionRuntimeAfterDispose?: boolean;
  },
): Promise<StaticHarnessMcpTools> {
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
    const fullPermission = params.autoApproveCodexAppServerApprovals === true;
    const policyTools = applyHarnessToolPolicy(liveRuntime.tools, policyParams);
    const projectedApproval = params.projectedMcpServers
      ? { projectedMcpServers: params.projectedMcpServers }
      : {};
    const allowed = applyConfiguredMcpApproval(policyTools, {
      fullPermission,
      ...projectedApproval,
      ...(params.requestInteractiveCodexApproval
        ? { requestApproval: params.requestInteractiveCodexApproval }
        : {}),
      onOmitted: (message) => policyWarnings.push(message),
    });
    // App views outlive this attempt, so bind their callable surface to the
    // same complete catalog and final policy before any model tool can mint one.
    liveRuntime.restrictAppTools?.(
      applyConfiguredMcpApproval(
        applyHarnessToolPolicy(liveRuntime.appTools ?? liveRuntime.tools, policyParams),
        {
          fullPermission,
          ...projectedApproval,
          ...(params.requestInteractiveCodexApproval
            ? {}
            : { onOmitted: (message: string) => policyWarnings.push(message) }),
        },
      ),
    );
    const diagnosticNotice = formatConfiguredMcpDiagnosticNotice(
      [
        ...(liveRuntime.diagnostics ?? []).map(
          (diagnostic) => `${diagnostic.serverName}: ${diagnostic.message}`,
        ),
        ...policyWarnings,
      ],
      params.requestInteractiveCodexApproval ? "this run" : "this scheduled run",
    );
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
  const scopedRuntimeHandle = await getOrCreateRequesterScopedMcpRuntime({
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
  const scopedRuntime = scopedRuntimeHandle?.runtime;

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
      if (liveCatalog.tools.length > 0 && scopedRuntimeHandle) {
        rememberAdvertisedScopedMcpCatalog(scopedRuntimeHandle, liveCatalog);
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
