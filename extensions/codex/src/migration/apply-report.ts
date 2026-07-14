import type { CodexPluginActivationResult } from "../app-server/plugin-activation.js";
// Codex plugin activation details exposed in migration reports.
import type { v2 } from "../app-server/protocol.js";

export function codexPluginActivationReportState(result: CodexPluginActivationResult): {
  installed?: boolean;
  enabled?: boolean;
} {
  switch (result.reason) {
    case "already_active":
    case "installed":
      return { installed: true, enabled: true };
    case "auth_required":
      return { installed: true, enabled: false };
    case "disabled":
    case "marketplace_missing":
    case "plugin_missing":
      return { installed: false, enabled: false };
    case "refresh_failed":
      return { installed: true, enabled: false };
  }
  const exhaustiveReason: never = result.reason;
  return exhaustiveReason;
}

export function sanitizeAppsNeedingAuth(apps: readonly v2.AppSummary[]): Array<{
  id: string;
  name: string;
  needsAuth: boolean;
}> {
  return apps.map((app) => ({
    id: app.id,
    name: app.name,
    needsAuth: app.needsAuth,
  }));
}
