// Private helper surface for the bundled Codex plugin. Mirrors the Codex CLI
// runtime's user-mcp-server projection so the bundled Codex app-server harness
// can attach the same user `mcp.servers` entries to its thread config without
// deep-importing core helpers.
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";

export {
  buildCodexUserMcpServersThreadConfigPatch,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export { runWithCronCreatorAuthorityResolver } from "../agents/cron-creator-authority-context.js";

/** Materialize static configured MCP under a scheduled Codex authority envelope. */
export async function materializeStaticMcpToolsForScheduledHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForScheduledHarnessRun
  >[0],
) {
  const { materializeStaticMcpToolsForScheduledHarnessRun: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
) {
  const [{ captureFinalEffectiveCronCreatorToolAllowlist: capture }, { getPluginToolMeta }] =
    await Promise.all([import("../agents/tools/cron-tool.js"), import("../plugins/tools.js")]);
  return capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool));
}
