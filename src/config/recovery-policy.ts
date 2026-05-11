import type { ConfigFileSnapshot, ConfigValidationIssue } from "./types.openclaw.js";

const PLUGIN_ENTRY_PATH_PREFIX = "plugins.entries.";
const PLUGIN_POLICY_PATHS = new Set(["plugins.allow", "plugins.deny"]);

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

/**
 * Returns true when an invalid config snapshot is scoped entirely to stale plugin refs.
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
