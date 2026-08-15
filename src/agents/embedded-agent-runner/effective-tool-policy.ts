/**
 * Applies final effective tool policy to embedded-agent runtime settings.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getPluginToolMeta } from "../../plugins/tools.js";
import type { ResolvedConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../conversation-tool-policy-pipeline.js";
import { buildDeclaredToolAllowlistContext } from "../tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  type ToolPolicyFilterEvent,
  type ToolPolicyPipelineStep,
} from "../tool-policy-pipeline.js";
import { collectExplicitDenylist } from "../tool-policy.js";
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
  toolPolicyAuditLogLevel?: "info" | "debug";
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
    auditLogLevel: params.toolPolicyAuditLogLevel,
    onFilter: params.onFilter,
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      toolDenylist: collectExplicitDenylist(pipelineSteps.map((step) => step.policy)),
    }),
  });
}
