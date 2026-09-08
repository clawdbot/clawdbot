// The bundled handler and diagnostics read the same declared extra files.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { loadExtraBootstrapFilesWithDiagnostics } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHookConfig } from "../../config.js";

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
