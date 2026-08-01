import { resolveExecCommandHighlighting } from "../config/exec-command-highlighting.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { resolveMergedSafeBinProfileFixtures } from "../infra/exec-safe-bin-runtime-policy.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { describeExecTool } from "./bash-tools.descriptions.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { execSchema } from "./bash-tools.schemas.js";
import { EXEC_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AnyAgentTool } from "./tools/common.js";

type BashToolsModule = typeof import("./bash-tools.js");

const bashToolsModuleLoader = createLazyImportLoader<BashToolsModule>(
  () => import("./bash-tools.js"),
);

type LazyExecToolPresentation = Partial<
  Pick<AnyAgentTool, "description" | "displaySummary" | "parameters">
>;

/** Build the exec tool lazily so non-shell agent surfaces avoid loading bash runtime code. */
export function createLazyExecTool(
  defaults?: ExecToolDefaults,
  presentation?: LazyExecToolPresentation,
): AnyAgentTool {
  let loadedTool: AnyAgentTool | undefined;
  const loadTool = async () => {
    if (!loadedTool) {
      const { createExecTool } = await bashToolsModuleLoader.load();
      loadedTool = createExecTool(defaults) as unknown as AnyAgentTool;
    }
    return loadedTool;
  };

  return {
    name: "exec",
    label: "exec",
    displaySummary: presentation?.displaySummary ?? EXEC_TOOL_DISPLAY_SUMMARY,
    get description() {
      return (
        presentation?.description ??
        describeExecTool({
          agentId: defaults?.agentId,
          hasCronTool: defaults?.hasCronTool === true,
        })
      );
    },
    parameters: presentation?.parameters ?? execSchema,
    prepareBeforeToolCallParams: async (...args) =>
      (await loadTool()).prepareBeforeToolCallParams?.(...args) ?? args[0],
    finalizeBeforeToolCallParams: (params, preparedParams) =>
      loadedTool?.finalizeBeforeToolCallParams?.(params, preparedParams) ?? params,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      (await loadTool()).execute(...args),
  } as AnyAgentTool;
}

/** Resolve global and per-agent exec defaults before runtime-only overrides. */
export function resolveExecToolConfig(params: { cfg?: OpenClawConfig; agentId?: string }) {
  const cfg = params.cfg;
  const globalExec = cfg?.tools?.exec;
  const agentExec =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined;
  const layeredPolicy = applyExecPolicyLayer(applyExecPolicyLayer({}, globalExec), agentExec);
  return {
    host: agentExec?.host ?? globalExec?.host,
    mode: layeredPolicy.mode,
    security: layeredPolicy.security,
    ask: layeredPolicy.ask,
    node: agentExec?.node ?? globalExec?.node,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
    strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
    commandHighlighting: resolveExecCommandHighlighting({
      config: cfg,
      agentId: params.agentId,
    }),
    safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
    safeBinProfiles: resolveMergedSafeBinProfileFixtures({
      global: globalExec,
      local: agentExec,
    }),
    reviewer: agentExec?.reviewer ?? globalExec?.reviewer,
    backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
    timeoutSec: agentExec?.timeoutSeconds ?? globalExec?.timeoutSeconds,
    approvalRunningNoticeMs:
      agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
    cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
    notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
    notifyOnExitEmptySuccess:
      agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
    applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch,
  };
}
