import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
// MCP loopback runtime scope cache.
// Retains attempt-owned executables while refreshing current node-exec availability.
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";
import type { McpLoopbackClientCapture, McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// Only attachment metadata expires. Executable CLI resources close with their capture.
const TOOL_CACHE_TTL_MS = 30_000;
const TOOL_CACHE_MAX_ENTRIES = 256;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type NodeExecAvailability = Awaited<ReturnType<typeof loadNodeExecAvailability>>;

type ScopedLoopbackTools = {
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
  refreshNodeExecTools?: (availability: NodeExecAvailability["isAvailable"]) => McpLoopbackTool[];
};

type CachedScopedTools = {
  agentId: string | undefined;
  // Tool policy resolves the workspace root (grant value, else the agent's
  // configured workspace). Hook context must carry the same one the tools were
  // built with, or before-tool-call policy resolves state against a different root.
  workspaceDir: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  nodeExec?: { key: string; refresh: NonNullable<ScopedLoopbackTools["refreshNodeExecTools"]> };
};

type McpLoopbackScopeParams = Omit<McpLoopbackRequestContext, "senderIsOwner" | "skillWorkshop"> & {
  skillWorkshop?: SkillWorkshopRunOptions;
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  registerRunCleanup?: Parameters<typeof resolveGatewayScopedTools>[0]["registerRunCleanup"];
  computerTransport?: Parameters<typeof resolveGatewayScopedTools>[0]["computerTransport"];
  senderIsOwner: boolean | undefined;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  nodeExecAvailability?: NodeExecAvailability;
  signal?: AbortSignal;
};

type LoopbackToolsAllowMode = "exact" | "policy";

function resolveMediatedNativeTools(
  toolsAllow: string[] | undefined,
  mode: LoopbackToolsAllowMode,
): Set<string> {
  if (mode === "exact") {
    return new Set(
      (toolsAllow ?? [])
        .map((name) => normalizeToolPolicyName(name))
        .filter((name) => NATIVE_TOOL_EXCLUDE.has(name)),
    );
  }
  if (
    toolsAllow === undefined ||
    toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
  ) {
    return new Set();
  }
  return new Set(
    applyEmbeddedAttemptToolsAllow(
      Array.from(NATIVE_TOOL_EXCLUDE, (name) => ({ name })),
      toolsAllow,
    ).map((tool) => tool.name),
  );
}

async function resolveNodeExecScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<McpLoopbackScopeParams> {
  if (
    params.nodeExecAllowed !== true ||
    resolveMediatedNativeTools(params.toolsAllow, mode).size > 0
  ) {
    return params;
  }
  return { ...params, nodeExecAvailability: await loadNodeExecAvailability(params.signal) };
}

function resolveMcpLoopbackTools(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): ScopedLoopbackTools {
  params.signal?.throwIfAborted();
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools = resolveMediatedNativeTools(params.toolsAllow, mode);
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = params.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const {
    toolsAllow,
    authProfileStoreAgentDir,
    nodeExecAvailability,
    signal: _signal,
    ...scopeParams
  } = params;
  const scoped = resolveGatewayScopedTools({
    ...scopeParams,
    agentDir: authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
    nodeExecAvailable: nodeExecAvailability?.isAvailable,
  });
  const filterTools = (tools: McpLoopbackTool[]) =>
    mode === "exact"
      ? applyGrantToolsAllow(tools, toolsAllow)
      : applyPolicyToolsAllow(tools, toolsAllow);
  const refreshNodeExecTools = scoped.refreshNodeExecTools;
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools: filterTools(scoped.tools),
    ...(refreshNodeExecTools
      ? {
          refreshNodeExecTools: (availability: NodeExecAvailability["isAvailable"]) =>
            filterTools(refreshNodeExecTools(availability)),
        }
      : {}),
  };
}

/** Resolves loopback-visible tools from the exact names carried by a minted grant. */
export async function resolveMcpLoopbackScopedTools(
  params: McpLoopbackScopeParams,
): Promise<ScopedLoopbackTools> {
  return resolveMcpLoopbackTools(await resolveNodeExecScope(params, "exact"), "exact");
}

/** Materializes runtime policy expressions against the concrete loopback catalog. */
export async function resolveMcpLoopbackPolicyTools(
  params: McpLoopbackScopeParams,
): Promise<ScopedLoopbackTools> {
  return resolveMcpLoopbackTools(await resolveNodeExecScope(params, "policy"), "policy");
}

/**
 * Hard-enforces a per-run grant allowlist on the loopback surface. Both
 * tools/list and tools/call consume this list, so a tool outside the
 * allowlist can be neither discovered nor executed even when the CLI runs
 * with a bypass permission mode. An empty allowlist fails closed.
 */
function applyGrantToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  const allowed = new Set(toolsAllow.map((name) => normalizeToolPolicyName(name)).filter(Boolean));
  return tools.filter((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name !== undefined && allowed.has(normalizeToolPolicyName(name));
  });
}

function applyPolicyToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  // Grant lists remain exact; only this pre-mint path may expand groups,
  // globs, plugin ids, and write-to-apply_patch policy semantics.
  const candidates = tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name ? [{ name, tool }] : [];
  });
  return applyEmbeddedAttemptToolsAllow(candidates, toolsAllow, {
    toolMeta: (candidate) => getPluginToolMeta(candidate.tool),
  }).map((candidate) => candidate.tool);
}

/** Attach projections expire; stateful CLI executables belong to one exact capture. */
export class McpLoopbackToolCache {
  #attachments = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  #attachmentEpoch = 0;
  #clients = new WeakMap<McpLoopbackClientCapture, WeakMap<OpenClawConfig, CachedScopedTools>>();

  async resolve(
    input: McpLoopbackScopeParams,
    capture?: McpLoopbackClientCapture,
  ): Promise<CachedScopedTools> {
    input.signal?.throwIfAborted();
    capture?.signal.throwIfAborted();
    const epoch = this.#attachmentEpoch;
    const signal =
      capture && input.signal
        ? AbortSignal.any([capture.signal, input.signal])
        : (capture?.signal ?? input.signal);
    const params = await resolveNodeExecScope({ ...input, signal }, "exact");
    signal?.throwIfAborted();
    capture?.signal.throwIfAborted();
    let clientEntries = capture && this.#clients.get(capture);
    if (capture && !clientEntries) {
      clientEntries = new WeakMap();
      this.#clients.set(capture, clientEntries);
      capture.registerRunCleanup(async () => {
        this.#clients.delete(capture);
      });
    }
    const attachmentKey = JSON.stringify([params.sessionKey, params.agentId]);
    const cached = clientEntries
      ? clientEntries.get(params.cfg)
      : this.#attachments.get(attachmentKey, params.cfg);
    let entry: CachedScopedTools;
    if (cached) {
      const view = cached.nodeExec;
      const availability = params.nodeExecAvailability;
      if (!view || !availability || view.key === availability.cacheKey) {
        return cached;
      }
      // Changing inventory may hide/reveal node exec, but never replace the
      // computer session, its binding, or the other retained executable tools.
      const tools = view.refresh(availability.isAvailable);
      entry = {
        ...cached,
        tools,
        toolSchema: buildMcpToolSchema(tools),
        nodeExec: { ...view, key: availability.cacheKey },
      };
    } else {
      const next = resolveMcpLoopbackTools(
        {
          ...params,
          registerRunCleanup: capture?.registerRunCleanup,
          computerTransport: capture ? capture.createComputerTransport() : params.computerTransport,
        },
        "exact",
      );
      const nodeExec =
        next.refreshNodeExecTools && params.nodeExecAvailability
          ? { key: params.nodeExecAvailability.cacheKey, refresh: next.refreshNodeExecTools }
          : undefined;
      entry = {
        agentId: next.agentId,
        workspaceDir: next.workspaceDir,
        tools: next.tools,
        toolSchema: buildMcpToolSchema(next.tools),
        ...(nodeExec ? { nodeExec } : {}),
      };
    }
    signal?.throwIfAborted();
    capture?.signal.throwIfAborted();
    if (clientEntries) {
      clientEntries.set(params.cfg, entry);
    } else if (epoch === this.#attachmentEpoch) {
      this.#attachments.set(attachmentKey, entry, params.cfg);
    }
    return entry;
  }

  clear(): void {
    this.#attachmentEpoch += 1;
    this.#attachments.clear();
    // Capture cleanup owns executable eviction; unrelated metadata invalidation
    // must not abandon a live computer session or its eventual cleanup result.
  }
}
