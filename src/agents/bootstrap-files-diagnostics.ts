// Hook discovery belongs only to diagnostics, not normal bootstrap preparation.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadDeclaredExtraBootstrapFiles } from "../hooks/bundled/bootstrap-extra-files/declared-files.js";
import { isHookLoadable, resolveInternalHookSelection } from "../hooks/configured.js";
import { loadWorkspaceHookEntries } from "../hooks/workspace.js";
import { tryResolveConfiguredAgentWorkspaceDir } from "./agent-scope-config.js";
import { resolveBootstrapContextWithProjectedHookFiles } from "./bootstrap-files.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace-default.js";

function isBundledExtraFilesHookSelected(config: OpenClawConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  const selection = resolveInternalHookSelection(config);
  if (!selection.configured) {
    return false;
  }
  // Startup selects hooks once in the Gateway workspace; extra paths are per agent.
  const discoveryDir =
    tryResolveConfiguredAgentWorkspaceDir(config) ?? resolveDefaultAgentWorkspaceDir();
  const selected = loadWorkspaceHookEntries(discoveryDir, { config }).find(
    (entry) => entry.hook.name === "bootstrap-extra-files",
  );
  return (
    selected?.hook.source === "openclaw-bundled" &&
    isHookLoadable({ entry: selected, config, names: selection.names })
  );
}

/** Projects fresh-start bundled declarations without importing or invoking hook handlers. */
export async function resolveBootstrapContextForDiagnostics(
  params: Parameters<typeof resolveBootstrapContextWithProjectedHookFiles>[0],
): ReturnType<typeof resolveBootstrapContextWithProjectedHookFiles> {
  if (!isBundledExtraFilesHookSelected(params.config)) {
    return resolveBootstrapContextWithProjectedHookFiles(params, []);
  }
  const declared = await loadDeclaredExtraBootstrapFiles({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  return resolveBootstrapContextWithProjectedHookFiles(params, declared.files);
}
