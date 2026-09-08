// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  loadPairedComputerUseAvailabilityForSurface,
  type PairedComputerUseAvailability,
} from "../agents/computer-use-node-capabilities.js";
import {
  isCoreCodingSurfaceToolName,
  listCoreToolFactoryDescriptors,
} from "../agents/core-tool-factory-descriptors.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import type { PreparedRootedExecutionCapability } from "../agents/rooted-run-params.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// MCP loopback runtime scopes gateway tools to the current session/channel
// context and caches the expensive schema projection for short bursts of tool
// list/call traffic from the same MCP client.
const TOOL_CACHE_TTL_MS = 30_000;
const TOOL_CACHE_MAX_ENTRIES = 256;
const NATIVE_TOOL_EXCLUDE = new Set(
  listCoreToolFactoryDescriptors()
    .map(({ name }) => name)
    .filter(isCoreCodingSurfaceToolName),
);

type CachedScopedTools = {
  agentId: string | undefined;
  // Tool policy resolves the workspace root (grant value, else the agent's
  // configured workspace). Hook context must carry the same one the tools were
  // built with, or before-tool-call policy resolves state against a different root.
  workspaceDir: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
};

type McpLoopbackScopeParams = {
  context: Omit<McpLoopbackRequestContext, "senderIsOwner"> & { senderIsOwner?: boolean };
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  rootedExecution?: PreparedRootedExecutionCapability;
  grantToken?: string;
  yieldContextCacheKey?: string;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  nodeExecAvailability?: Awaited<ReturnType<typeof loadNodeExecAvailability>>;
  pairedComputerUseAvailability?: PairedComputerUseAvailability;
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
  const shouldResolveExec =
    !params.rootedExecution &&
    params.context.nodeExecAllowed === true &&
    resolveMediatedNativeTools(params.context.toolsAllow, mode).size === 0;
  if (!shouldResolveExec) {
    return params;
  }
  return { ...params, nodeExecAvailability: await loadNodeExecAvailability(params.signal) };
}

function isComputerAllowedByMcpScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): boolean {
  const { toolsAllow } = params.context;
  if (mode === "exact") {
    return (
      toolsAllow === undefined ||
      toolsAllow.some((name) => normalizeToolPolicyName(name) === "computer")
    );
  }
  return applyEmbeddedAttemptToolsAllow([{ name: "computer" }], toolsAllow).length === 1;
}

type ResolvedNodeScope = {
  params: McpLoopbackScopeParams;
  policyResolved?: {
    agentId: string | undefined;
    workspaceDir?: string;
    tools: McpLoopbackTool[];
  };
};

async function resolveNodeScope(
  input: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<ResolvedNodeScope> {
  return resolvePairedComputerNodeScope(await resolveNodeExecScope(input, mode), mode);
}

async function resolvePairedComputerNodeScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<ResolvedNodeScope> {
  const canReachOrdinaryComputerSurface =
    isComputerAllowedByMcpScope(params, mode) &&
    params.context.modelHasVision !== false &&
    !params.rootedExecution;
  if (!canReachOrdinaryComputerSurface) {
    return { params };
  }
  // Resolve the actual configured surface before contacting Gateway. Grant policy
  // alone is insufficient: profile, agent, sandbox, sender, and Gateway policy
  // can all remove computer from the final catalog.
  const policyResolved = resolveMcpLoopbackTools(params, mode);
  const computerAllowed = policyResolved.tools.some(
    (tool) => readMcpLoopbackToolName(tool) === "computer",
  );
  const pairedComputerUseAvailability = await loadPairedComputerUseAvailabilityForSurface({
    computerAllowed,
    modelHasVision: params.context.modelHasVision,
    computerTransport: params.rootedExecution ? null : undefined,
    signal: params.signal,
  });
  if (!pairedComputerUseAvailability) {
    return { params, policyResolved };
  }
  const resolvedParams = {
    params: {
      ...params,
      pairedComputerUseAvailability,
    },
  };
  // An empty inventory preserves the fallback schema, so the policy-resolved
  // catalog is already final. A prepared inventory must rebuild computer with
  // the paired action projection.
  return pairedComputerUseAvailability.prepared
    ? resolvedParams
    : { ...resolvedParams, policyResolved };
}

function resolveMcpLoopbackTools(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): {
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
} {
  params.signal?.throwIfAborted();
  const { toolsAllow, ...context } = params.context;
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools = params.rootedExecution
    ? new Set(NATIVE_TOOL_EXCLUDE)
    : resolveMediatedNativeTools(toolsAllow, mode);
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = context.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const skillWorkshop =
    context.skillWorkshop || params.skillLibraryAuthoring
      ? { ...context.skillWorkshop, libraryAuthoring: params.skillLibraryAuthoring }
      : undefined;
  const scoped = resolveGatewayScopedTools({
    ...context,
    rootedExecution: params.rootedExecution,
    cfg: params.cfg,
    authProfileStore: params.authProfileStore,
    onYield: params.onYield,
    skillWorkshop,
    nativeCronCreatorToolAllowlist: context.nativeCronCreatorToolAllowlist ?? undefined,
    agentDir: params.authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
    nodeExecAvailable: params.nodeExecAvailability?.isAvailable,
    pairedNodeComputerUse: params.pairedComputerUseAvailability?.prepared,
  });
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools:
      mode === "exact"
        ? applyGrantToolsAllow(scoped.tools, toolsAllow)
        : applyPolicyToolsAllow(scoped.tools, toolsAllow),
  };
}

/** Resolves loopback-visible tools from the exact names carried by a minted grant. */
export async function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
}> {
  const resolved = await resolveNodeScope(params, "exact");
  return resolved.policyResolved ?? resolveMcpLoopbackTools(resolved.params, "exact");
}

/** Materializes runtime policy expressions against the concrete loopback catalog. */
export async function resolveMcpLoopbackPolicyTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  tools: McpLoopbackTool[];
}> {
  const resolved = await resolveNodeScope(params, "policy");
  return resolved.policyResolved ?? resolveMcpLoopbackTools(resolved.params, "policy");
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

function buildMcpLoopbackToolCacheKey(params: McpLoopbackScopeParams): string {
  const { context } = params;
  // Only the serializable grant context enters this key. Prepared credentials,
  // authoring capabilities, and callbacks stay bound to their grant lifetime.
  return `${params.grantToken ?? ""}\u0000${stableStringify({
    context: {
      ...context,
      clientCaps: [...new Set(context.clientCaps ?? [])].toSorted(),
      // Missing allows all; an empty list denies all.
      toolsAllow: context.toolsAllow ? [...new Set(context.toolsAllow)].toSorted() : undefined,
      modelHasVision: context.modelHasVision,
      pinnedWidgetAuthoring: context.pinnedWidgetAuthoring === true,
      currentInboundAudio: context.currentInboundAudio === true,
      sourceReplyOnly: context.sourceReplyOnly === true,
      requireExplicitMessageTarget: context.requireExplicitMessageTarget === true,
      nodeExecAllowed: context.nodeExecAllowed === true,
      delegationCapability:
        context.delegationCapability === "report_only" ? "report_only" : undefined,
    },
    authProfileStoreAgentDir: params.authProfileStoreAgentDir,
    yieldContextCacheKey: params.yieldContextCacheKey,
    nodeExecAvailability: params.nodeExecAvailability?.cacheKey,
    pairedComputerUseAvailability: params.pairedComputerUseAvailability?.cacheKey,
  })}`;
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  #entries = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  // Revocation needs the config scopes where one grant may have cached tools.
  #grantConfigScopes = new Map<string, Set<OpenClawConfig>>();
  #epoch = 0;

  async resolve(input: McpLoopbackScopeParams): Promise<CachedScopedTools> {
    const epoch = this.#epoch;
    const nodeExecParams = await resolveNodeExecScope(input, "exact");
    input.signal?.throwIfAborted();
    // A policy-excluded computer scope has no inventory component. It can use
    // the ordinary cached catalog without touching Gateway again.
    const preDiscoveryCacheKey = buildMcpLoopbackToolCacheKey(nodeExecParams);
    const preDiscoveryCached = this.#entries.get(preDiscoveryCacheKey, nodeExecParams.cfg);
    if (preDiscoveryCached) {
      return preDiscoveryCached;
    }

    // Availability belongs to the current connection, not the schema TTL.
    const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
    input.signal?.throwIfAborted();
    const { params } = resolved;
    const cacheKey = buildMcpLoopbackToolCacheKey(params);
    const cached = this.#entries.get(cacheKey, params.cfg);
    if (cached) {
      return cached;
    }

    const next = resolved.policyResolved ?? resolveMcpLoopbackTools(params, "exact");
    const nextEntry: CachedScopedTools = {
      agentId: next.agentId,
      workspaceDir: next.workspaceDir,
      tools: next.tools,
      toolSchema: buildMcpToolSchema(next.tools),
    };
    // Revocation may overtake discovery before a grant owns any cached rows.
    if (epoch !== this.#epoch) {
      return nextEntry;
    }
    this.#entries.set(cacheKey, nextEntry, params.cfg);
    if (params.grantToken) {
      const scopes = this.#grantConfigScopes.get(params.grantToken) ?? new Set<OpenClawConfig>();
      scopes.add(params.cfg);
      this.#grantConfigScopes.set(params.grantToken, scopes);
    }
    return nextEntry;
  }

  evictGrant(token: string): boolean {
    this.#epoch += 1;
    const scopes = this.#grantConfigScopes.get(token);
    if (!scopes) {
      return false;
    }
    const cacheKeyPrefix = `${token}\u0000`;
    for (const cfg of scopes) {
      this.#entries.clearMatching((cacheKey) => cacheKey.startsWith(cacheKeyPrefix), cfg);
    }
    this.#grantConfigScopes.delete(token);
    return true;
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
    this.#grantConfigScopes.clear();
  }
}
