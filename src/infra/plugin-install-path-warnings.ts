import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type PluginInstallPathIssue = {
  kind: "custom-path" | "missing-path";
  pluginId: string;
  path: string;
};

function resolvePluginInstallCandidatePaths(
  install: PluginInstallRecord | null | undefined,
): string[] {
  if (!install || install.source !== "path") {
    return [];
  }

  return [install.sourcePath, install.installPath]
    .map((value) => normalizeOptionalString(value) ?? "")
    .filter(Boolean);
}

export async function detectPluginInstallPathIssue(params: {
  pluginId: string;
  install: PluginInstallRecord | null | undefined;
}): Promise<PluginInstallPathIssue | null> {
  const candidatePaths = resolvePluginInstallCandidatePaths(params.install);
  if (candidatePaths.length === 0) {
    return null;
  }

  for (const candidatePath of candidatePaths) {
    try {
      await fs.access(path.resolve(candidatePath));
      return {
        kind: "custom-path",
        pluginId: params.pluginId,
        path: candidatePath,
      };
    } catch {
      // Keep checking remaining candidate paths before warning about a stale install.
    }
  }

  return {
    kind: "missing-path",
    pluginId: params.pluginId,
    path: candidatePaths[0] ?? "(unknown)",
  };
}

export function formatPluginInstallPathIssue(params: {
  issue: PluginInstallPathIssue;
  pluginLabel: string;
  defaultInstallCommand: string;
  repoInstallCommand?: string | null;
  formatCommand?: (command: string) => string;
}): string[] {
  const formatCommand = params.formatCommand ?? ((command: string) => command);
  if (params.issue.kind === "custom-path") {
    return [
      `${params.pluginLabel} is installed from a custom path: ${params.issue.path}`,
      `Main updates will not automatically replace that plugin with the repo's default ${params.pluginLabel} package.`,
      `Reinstall with "${formatCommand(params.defaultInstallCommand)}" when you want to return to the standard ${params.pluginLabel} plugin.`,
      ...(params.repoInstallCommand
        ? [
            `If you are intentionally running from a repo checkout, reinstall that checkout explicitly with "${formatCommand(params.repoInstallCommand)}" after updates.`,
          ]
        : []),
    ];
  }
  return [
    `${params.pluginLabel} is installed from a custom path that no longer exists: ${params.issue.path}`,
    `Reinstall with "${formatCommand(params.defaultInstallCommand)}".`,
    ...(params.repoInstallCommand
      ? [
          `If you are running from a repo checkout, you can also use "${formatCommand(params.repoInstallCommand)}".`,
        ]
      : []),
  ];
}
