import fs from "node:fs";
import path from "node:path";

/** Boot-stable quarantine state for configured plugins whose payload failed verification. */

export type PluginVerificationFailureReason =
  | "missing-install-path"
  | "missing-package-dir"
  | "missing-package-json"
  | "unreadable-package-json"
  | "invalid-package-json"
  | "missing-bundle-manifest"
  | "invalid-bundle-manifest"
  | "missing-main-entry"
  | "missing-extension-entry"
  | "missing-openclaw-peer-link";

type PluginVerificationDiagnostic = {
  kind: "plugin-verification";
  reason: PluginVerificationFailureReason;
  detail: string;
  installPath?: string;
};

type PublicPluginVerificationDiagnostic = Pick<
  PluginVerificationDiagnostic,
  "kind" | "reason" | "detail"
>;

export type DegradedPlugin = {
  pluginId: string;
  state: "configured-unavailable";
  diagnostic: PluginVerificationDiagnostic;
};

type PluginVerificationFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginVerificationFailureReason;
  detail: string;
};

let activeDegradedPlugins: DegradedPlugin[] = [];

function cloneDegradedPlugin(plugin: DegradedPlugin): DegradedPlugin {
  return {
    ...plugin,
    diagnostic: { ...plugin.diagnostic },
  };
}

/** Converts verified ownership failures into the quarantine state used for this boot. */
export function buildDegradedPluginsFromVerificationFailures(
  failures: readonly PluginVerificationFailure[],
): DegradedPlugin[] {
  const degraded = new Map<string, DegradedPlugin>();
  for (const failure of failures) {
    // One owner produces one quarantine record even when several payload files
    // fail verification; startup already emits every finding before this fold.
    if (degraded.has(failure.pluginId)) {
      continue;
    }
    degraded.set(failure.pluginId, {
      pluginId: failure.pluginId,
      state: "configured-unavailable",
      diagnostic: {
        kind: "plugin-verification",
        reason: failure.reason,
        detail: failure.detail,
        ...(failure.installPath ? { installPath: failure.installPath } : {}),
      },
    });
  }
  return [...degraded.values()];
}

/** Replaces the process-local quarantine snapshot established before Gateway plugin loading. */
export function setActiveDegradedPlugins(plugins: readonly DegradedPlugin[]): void {
  activeDegradedPlugins = plugins.map(cloneDegradedPlugin);
}

export function listActiveDegradedPlugins(): DegradedPlugin[] {
  return activeDegradedPlugins.map(cloneDegradedPlugin);
}

export function findActiveDegradedPlugin(pluginId: string): DegradedPlugin | undefined {
  const plugin = activeDegradedPlugins.find((entry) => entry.pluginId === pluginId);
  return plugin ? cloneDegradedPlugin(plugin) : undefined;
}

/** Drops a verification failure that belongs to a different selected plugin root. */
export function clearActiveDegradedPlugin(pluginId: string): void {
  activeDegradedPlugins = activeDegradedPlugins.filter((entry) => entry.pluginId !== pluginId);
}

/** Matches an install-record path and discovered root across symlink/path aliases. */
export function pluginInstallPathMatchesRoot(
  installPath: string | undefined,
  rootDir: string,
): boolean {
  if (!installPath) {
    return false;
  }
  const canonicalize = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonicalize(installPath) === canonicalize(rootDir);
}

/** Matches install-record and discovered roots across symlink/path aliases. */
export function degradedPluginMatchesRoot(plugin: DegradedPlugin, rootDir: string): boolean {
  return pluginInstallPathMatchesRoot(plugin.diagnostic.installPath, rootDir);
}

/** Removes the known private install root before diagnostics leave the Gateway process. */
export function toPublicPluginVerificationDiagnostic(
  diagnostic: PluginVerificationDiagnostic,
): PublicPluginVerificationDiagnostic {
  const detail =
    diagnostic.reason === "missing-openclaw-peer-link"
      ? 'Plugin declares peerDependency "openclaw", but its host peer link is missing or invalid.'
      : diagnostic.installPath
        ? diagnostic.detail.replaceAll(diagnostic.installPath, "<plugin-install>")
        : diagnostic.detail;
  return {
    kind: diagnostic.kind,
    reason: diagnostic.reason,
    detail,
  };
}

export function formatPluginVerificationDiagnostic(
  diagnostic: PluginVerificationDiagnostic,
): string {
  const publicDiagnostic = toPublicPluginVerificationDiagnostic(diagnostic);
  return `configured plugin payload verification failed (${publicDiagnostic.reason}): ${publicDiagnostic.detail}`;
}
