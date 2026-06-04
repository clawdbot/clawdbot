// Decides when config recovery should use snapshots, backups, or defaults.
import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.openclaw.js";

const PLUGIN_ENTRY_PATH_PREFIX = "plugins.entries.";
const PLUGIN_POLICY_PATHS = new Set(["plugins.allow", "plugins.deny"]);
const COMPILED_RUNTIME_OUTPUT_DIAGNOSTIC = "compiled runtime output";
const PLUGIN_DIAGNOSTIC_PREFIX_PATTERN = /^plugin\s+([^:\s]+):\s/u;
const PLUGIN_NOT_FOUND_PATTERN = /^plugin not found:\s*([^\s(]+)/u;

function isPluginsPath(path: string): boolean {
  return path === "plugins" || path.startsWith("plugins.");
}

function isPluginEntryIssue(issue: ConfigValidationIssue): boolean {
  const path = issue.path.trim();
  if (!path.startsWith(PLUGIN_ENTRY_PATH_PREFIX)) {
    return false;
  }
  return path.slice(PLUGIN_ENTRY_PATH_PREFIX.length).trim().length > 0;
}

function isPluginPolicyIssue(issue: ConfigValidationIssue): boolean {
  return (
    PLUGIN_POLICY_PATHS.has(issue.path.trim()) &&
    issue.message.trim().startsWith("plugin not found:")
  );
}

/** Return true for plugin validation issues caused by missing compiled runtime output. */
export function isPluginPackagingRuntimeOutputIssue(issue: ConfigValidationIssue): boolean {
  const path = issue.path.trim();
  const message = issue.message.trim().toLowerCase();
  return isPluginsPath(path) && message.includes(COMPILED_RUNTIME_OUTPUT_DIAGNOSTIC);
}

function isPluginPackagingFalloutIssue(issue: ConfigValidationIssue): boolean {
  const path = issue.path.trim();
  const message = issue.message.trim();
  return isPluginsPath(path) && message.startsWith("plugin not found:");
}

function normalizePluginIssueId(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function extractPluginPackagingRuntimeOutputPluginId(issue: ConfigValidationIssue): string | null {
  if (!isPluginPackagingRuntimeOutputIssue(issue)) {
    return null;
  }
  return normalizePluginIssueId(PLUGIN_DIAGNOSTIC_PREFIX_PATTERN.exec(issue.message.trim())?.[1]);
}

function extractPluginNotFoundIssuePluginId(issue: ConfigValidationIssue): string | null {
  if (!isPluginPackagingFalloutIssue(issue)) {
    return null;
  }
  return normalizePluginIssueId(PLUGIN_NOT_FOUND_PATTERN.exec(issue.message.trim())?.[1]);
}

/**
 * Return true when an invalid config snapshot is blocked only by plugin packaging fallout.
 * This lets callers show plugin repair hints instead of treating user config as corrupted.
 */
export function isPluginPackagingRuntimeOutputInvalidConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues"> &
    Partial<Pick<ConfigFileSnapshot, "warnings">>,
): boolean {
  if (snapshot.valid || (snapshot.legacyIssues?.length ?? 0) > 0 || snapshot.issues.length === 0) {
    return false;
  }
  const packagingIssues = [...snapshot.issues, ...(snapshot.warnings ?? [])].filter(
    isPluginPackagingRuntimeOutputIssue,
  );
  const packagingPluginIds = new Set(
    packagingIssues
      .map((issue) => extractPluginPackagingRuntimeOutputPluginId(issue))
      .filter((pluginId): pluginId is string => pluginId !== null),
  );
  return (
    packagingIssues.length > 0 &&
    snapshot.issues.every((issue) => {
      if (isPluginPackagingRuntimeOutputIssue(issue)) {
        return true;
      }
      // Missing-plugin fallout must belong to the same plugin that emitted the packaging error.
      const pluginId = extractPluginNotFoundIssuePluginId(issue);
      return pluginId !== null && packagingPluginIds.has(pluginId);
    })
  );
}

/**
 * Return true when an invalid config snapshot is scoped entirely to stale plugin refs.
 * Whole-file recovery is skipped for these snapshots so plugin cleanup can preserve user config.
 */
export function isPluginLocalInvalidConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">,
): boolean {
  if (snapshot.valid || snapshot.legacyIssues.length > 0 || snapshot.issues.length === 0) {
    return false;
  }
  return snapshot.issues.every((issue) => isPluginEntryIssue(issue) || isPluginPolicyIssue(issue));
}

/**
 * Decide whether whole-file last-known-good recovery is appropriate for an invalid snapshot.
 * Plugin-local failures stay on the current file so targeted plugin cleanup can run.
 */
export function shouldAttemptLastKnownGoodRecovery(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">,
): boolean {
  if (snapshot.valid) {
    return false;
  }
  return !isPluginLocalInvalidConfigSnapshot(snapshot);
}
