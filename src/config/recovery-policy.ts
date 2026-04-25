import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.openclaw.js";

const PLUGIN_ENTRY_PATH_PREFIX = "plugins.entries.";

function isPluginEntryIssue(issue: ConfigValidationIssue): boolean {
  const path = issue.path.trim();
  if (!path.startsWith(PLUGIN_ENTRY_PATH_PREFIX)) {
    return false;
  }
  return path.slice(PLUGIN_ENTRY_PATH_PREFIX.length).trim().length > 0;
}

/**
 * Returns true when an invalid config snapshot is scoped entirely to plugin entries.
 */
export function isPluginLocalInvalidConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">,
): boolean {
  if (snapshot.valid || snapshot.legacyIssues.length > 0 || snapshot.issues.length === 0) {
    return false;
  }
  return snapshot.issues.every(isPluginEntryIssue);
}

/**
 * Decides whether whole-file last-known-good recovery is safe for a snapshot.
 */
export function shouldAttemptLastKnownGoodRecovery(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">,
): boolean {
  if (snapshot.valid) {
    return false;
  }
  return !isPluginLocalInvalidConfigSnapshot(snapshot);
}
