// Declarative resolver for the bundled bootstrap-extra-files hook. The handler
// and hook-runtime-free callers (doctor) share it so both see the same additions.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveConfiguredAgentWorkspaceDir } from "../../../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHookConfig } from "../../config.js";
import { resolveLoadableHookEntries } from "../../workspace.js";

const HOOK_KEY = "bootstrap-extra-files";

/** Resolve legacy and current config keys for extra bootstrap file patterns. */
function resolveExtraBootstrapPatterns(cfg: OpenClawConfig | undefined): string[] {
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return [];
  }
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

/**
 * True when hook selection would register the bundled handler. Managed and
 * plugin hooks may replace it by name, and doctor must not describe files a
 * replacement never adds. The Gateway loads internal hooks once from its
 * default workspace (server-startup-plugins -> loadInternalHooks), never per
 * analyzed workspace, so discovery resolves that same directory here.
 */
export function isBundledExtraFilesHookSelected(cfg: OpenClawConfig | undefined): boolean {
  if (!cfg) {
    return false;
  }
  const discoveryDir =
    tryResolveConfiguredAgentWorkspaceDir(cfg) ?? resolveDefaultAgentWorkspaceDir();
  const selected = resolveLoadableHookEntries(cfg, discoveryDir).find(
    (entry) => entry.hook.name === HOOK_KEY,
  );
  return selected?.hook.source === "openclaw-bundled";
}

/** Loads the extra bootstrap files the hook config declares for a workspace. */
export async function loadDeclaredExtraBootstrapFiles(params: {
  config: OpenClawConfig | undefined;
  workspaceDir: string;
}): ReturnType<typeof loadExtraBootstrapFilesWithDiagnostics> {
  const patterns = resolveExtraBootstrapPatterns(params.config);
  if (patterns.length === 0) {
    return { files: [], diagnostics: [] };
  }
  return loadExtraBootstrapFilesWithDiagnostics(params.workspaceDir, patterns);
}
