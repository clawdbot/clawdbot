/**
 * Applies final effective tool policy to embedded-agent runtime settings.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { safeToolNameGlob, TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import type { McpToolCatalogDiagnostic } from "../agent-bundle-mcp-types.js";
import type { ResolvedConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../conversation-tool-policy-pipeline.js";
import { buildDeclaredToolAllowlistContext } from "../tool-policy-declared-context.js";
import { policiesAdmitToolNamespace } from "../tool-policy-match.js";
import {
  applyToolPolicyPipeline,
  type ToolPolicyFilterEvent,
  type ToolPolicyPipelineStep,
} from "../tool-policy-pipeline.js";
import {
  collectExplicitDenylist,
  expandPolicyWithPluginGroups,
  readToolAllowlistIntersection,
  type ToolPolicyLike,
} from "../tool-policy.js";
import type { AnyAgentTool } from "../tools/common.js";

/**
 * The capability profile is an authorization signal (group/sender policies can
 * widen bundled-tool availability), so callers MUST resolve it from
 * server-verified session metadata (session key, inbound transport event),
 * never from tool-call or model-controlled input. Passing the same profile
 * that constructed the core tool set keeps this final bundled-tool pass and
 * tool construction from ever disagreeing about policy inputs.
 */
type FinalEffectiveToolPolicyParams = {
  // Tools appended to the core tool set after `createOpenClawCodingTools()`
  // has already applied the shared tool-policy pipeline (e.g. bundled
  // MCP/LSP tools). Only these are filtered here; re-running the pipeline over
  // the already-filtered core tools would drop plugin tools whose WeakMap
  // metadata no longer survives core-tool wrapping/normalization.
  bundledTools: AnyAgentTool[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  conversationCapabilityProfile: ResolvedConversationCapabilityProfile;
  warn: (message: string) => void;
  onFilter?: (event: ToolPolicyFilterEvent) => void;
};

export function applyFinalEffectiveToolPolicy(
  params: FinalEffectiveToolPolicyParams,
): AnyAgentTool[] {
  if (params.bundledTools.length === 0) {
    return params.bundledTools;
  }
  const capabilityProfile = params.conversationCapabilityProfile;
  const { trustedGroup } = capabilityProfile.policy;
  // Resolve here for warnings and to strip caller-only group metadata before
  // this pass; resolveGroupToolPolicy re-checks internally for all callers.
  if (trustedGroup.dropped) {
    params.warn(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  }
  const policies = resolveConversationToolPolicies({ capabilityProfile });
  // Suppress unavailable-core-tool warnings on every step of this pass.
  // `applyToolPolicyPipeline` infers `coreToolNames` from the `tools` array
  // it's filtering, and this pass only sees the bundled MCP/LSP subset.
  // Normal core allowlist entries (e.g. `tools.allow: ["read", "exec"]`)
  // would look "unknown" relative to that reduced set even though they are
  // valid core names already resolved by `createOpenClawCodingTools()` in
  // the first pass — keeping those warnings on would pollute logs and evict
  // real diagnostics from the shared warning cache. Genuinely unknown
  // entries (typos) still surface through the `otherEntries` path in
  // `applyToolPolicyPipeline`.
  const pipelineSteps: ToolPolicyPipelineStep[] = buildConversationToolPolicyPipelineSteps({
    capabilityProfile,
    policies,
    includeRuntimeToolPolicy: false,
  }).map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true }));
  return applyToolPolicyPipeline({
    tools: params.bundledTools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: params.warn,
    steps: pipelineSteps,
    onFilter: params.onFilter,
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      toolDenylist: collectExplicitDenylist(pipelineSteps.map((step) => step.policy)),
    }),
  });
}

/**
 * Allow/deny layers one boundary applies to bundle MCP tools, as data a later
 * boundary can carry: layers must be judged together, since each one alone can
 * admit a different tool of a server while their intersection admits none.
 */
export function buildBundleMcpPolicyLayers(params: {
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  toolsAllow?: string[];
  /** Names other tools already hold; `buildSafeToolName` renames an MCP tool that collides. */
  reservedToolNames?: readonly string[];
}): ToolPolicyLike[] {
  const capabilityProfile = params.conversationCapabilityProfile;
  const allowlist = params.toolsAllow;
  const restrictions = allowlist ? (readToolAllowlistIntersection(allowlist) ?? [allowlist]) : [];
  return [
    // `applyEmbeddedAttemptToolsAllow` runs first for real bundle tools: it
    // intersects independent restrictions and reads an empty one as "no tools",
    // where a pipeline layer's empty allow list means allow-all.
    ...restrictions.map((allow) => (allow.length > 0 ? { allow } : { deny: ["*"] })),
    ...(capabilityProfile
      ? buildConversationToolPolicyPipelineSteps({
          capabilityProfile,
          policies: resolveConversationToolPolicies({ capabilityProfile }),
          includeRuntimeToolPolicy: false,
        }).flatMap((step) => step.policy ?? [])
      : []),
    // A failed server's tool whose safe name is already taken would have come
    // out renamed (`-2`), so an exact allow of the taken name admits none of it.
    ...(params.reservedToolNames ? [{ deny: [...params.reservedToolNames] }] : []),
  ];
}

/**
 * Whether the effective policy and a failed bundle MCP server's own tool filter
 * could still admit some tool of that server. A failed catalog load leaves its
 * tool names unknown, so its outage diagnostic is judged from the same allow/deny
 * layers as its tools, with the server namespace standing in for them.
 */
export function createBundleMcpServerPolicyMatcher(
  layers: readonly ToolPolicyLike[],
): (diagnostic: Pick<McpToolCatalogDiagnostic, "safeServerName" | "toolFilter">) => boolean {
  return ({ safeServerName, toolFilter }) => {
    // The failed server materialized no tools, so its namespace stands in for
    // the `bundle-mcp` plugin id every MCP tool carries: `bundle-mcp` and
    // `group:plugins` entries then expand as they do for a healthy server.
    const prefix = `${safeServerName}${TOOL_NAME_SEPARATOR}`;
    const namespaceTools = [`${prefix}*`];
    const groups = { all: namespaceTools, byPlugin: new Map([["bundle-mcp", namespaceTools]]) };
    // Healthy discovery applies the server's tool filter to raw names first; here
    // it is one more layer over the safe names those raw names become, judged with
    // the rest so no layer admits a tool alone. An empty `include` restricts nothing.
    const toGlob = (pattern: string) => safeToolNameGlob(safeServerName, pattern);
    return policiesAdmitToolNamespace(prefix, [
      ...layers.map((policy) => expandPolicyWithPluginGroups(policy, groups)),
      { allow: toolFilter?.include?.map(toGlob), deny: toolFilter?.exclude?.map(toGlob) },
    ]);
  };
}
