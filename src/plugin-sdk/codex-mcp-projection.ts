// Private thread-configuration projections for the bundled Codex plugin.
// Workspace preparation and MCP metadata remain separate from live run resources.
import { pinExecToolTarget } from "../agents/exec-tool-target-pinning.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessScheduledToolProjectionCapability,
  resolveAgentHarnessTtsProvenanceTransferCapability,
  type AgentHarnessScheduledToolProjectionFactory,
  type AgentHarnessTtsProvenanceTransfer,
} from "../agents/harness/host-private-capabilities.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";

export { pinExecToolTarget };
export { resolveBootstrapFilesForPreparation } from "../agents/bootstrap-files.js";
export type CodexScheduledToolProjectionFactory = AgentHarnessScheduledToolProjectionFactory;
export type CodexTtsProvenanceTransfer = AgentHarnessTtsProvenanceTransfer;

/** Resolve the private scheduled-tool projection issuer for the Codex harness owner. */
export function resolveCodexScheduledToolProjectionFactory(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexScheduledToolProjectionFactory | undefined {
  return resolveAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

/** Resolve private TTS delivery transfer for the bundled Codex harness owner. */
export function resolveCodexTtsProvenanceTransfer(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexTtsProvenanceTransfer | undefined {
  return resolveAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

export {
  buildCodexUserMcpServersThreadConfigPatch,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  buildCodexUserMcpServersThreadConfigPatchForRun,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export {
  runWithCronCreatorAuthorityCapabilityResolver,
  runWithCronCreatorAuthorityResolver,
} from "../agents/cron-creator-authority-context.js";

/** Materialize static configured MCP under a scheduled Codex authority envelope. */
export async function materializeStaticMcpToolsForScheduledHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForScheduledHarnessRunCore
  >[0],
) {
  const { materializeStaticMcpToolsForScheduledHarnessRunCore: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
) {
  const { captureFinalEffectiveCronCreatorToolAllowlist: capture } =
    await import("../agents/tools/cron-tool.js");
  return capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool));
}
