// Builds install hints for ACP runtimes missing local prerequisites.
import { existsSync } from "node:fs";
import path from "node:path";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveBundledPluginInstallCommandHint } from "../../../plugins/bundled-sources.js";

/** Resolves the install command hint shown when the configured ACP backend is missing. */
export function resolveAcpInstallCommandHint(cfg: OpenClawConfig): string {
  const configured = normalizeOptionalString(cfg.acp?.runtime?.installCommand);
  if (configured) {
    return configured;
  }
  const workspaceDir = process.cwd();
  const backendId = normalizeOptionalLowercaseString(cfg.acp?.backend) ?? "acpx";
  if (backendId === "acpx") {
    const workspaceLocalPath = path.join(workspaceDir, "extensions", "acpx");
    if (existsSync(workspaceLocalPath)) {
      return `openclaw plugins install ${workspaceLocalPath}`;
    }
    const bundledInstallHint = resolveBundledPluginInstallCommandHint({
      pluginId: backendId,
      workspaceDir,
    });
    if (bundledInstallHint) {
      const localPath = bundledInstallHint.replace(/^openclaw plugins install /u, "");
      const resolvedLocalPath = path.resolve(localPath);
      const relativeToWorkspace = path.relative(workspaceDir, resolvedLocalPath);
      // Only surface local path hints that belong to the current workspace.
      const belongsToWorkspace =
        relativeToWorkspace.length === 0 ||
        (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace));
      if (belongsToWorkspace && existsSync(resolvedLocalPath)) {
        return bundledInstallHint;
      }
    }
    return "openclaw plugins install acpx";
  }
  return `Install and enable the plugin that provides ACP backend "${backendId}".`;
}
