// Emits redacted plugin lifecycle security diagnostics for SIEM consumers.
import { emitTrustedSecurityEvent } from "../infra/diagnostic-events.js";

export type PluginSecuritySourceFamily =
  | "archive"
  | "directory"
  | "file"
  | "git"
  | "installed-package"
  | "npm";

type PluginSecurityMode = "install" | "update";
type PluginAuditReason = "security_scan_blocked" | "security_scan_failed";

function pluginLifecycleAction(mode: PluginSecurityMode): "plugin.installed" | "plugin.updated" {
  return mode === "update" ? "plugin.updated" : "plugin.installed";
}

export function pluginAuditOutcomeForReason(reason: PluginAuditReason): "denied" | "error" {
  return reason === "security_scan_failed" ? "error" : "denied";
}

export function emitPluginInstallSecurityEvent(params: {
  pluginId: string;
  mode: PluginSecurityMode;
  sourceFamily: PluginSecuritySourceFamily;
  extensionCount?: number;
  hasVersion?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
}) {
  emitTrustedSecurityEvent({
    category: "plugin",
    action: pluginLifecycleAction(params.mode),
    outcome: "success",
    severity: "medium",
    actor: {
      kind: "operator",
    },
    target: {
      kind: "plugin",
      name: params.pluginId,
    },
    policy: {
      id: "plugin.install",
      decision: "allow",
    },
    control: {
      id: "plugin.install",
      family: "supply_chain",
    },
    attributes: {
      source_family: params.sourceFamily,
      mode: params.mode,
      extension_count: params.extensionCount ?? 0,
      has_version: params.hasVersion ?? false,
      trusted_official_source: params.trustedSourceLinkedOfficialInstall === true,
    },
  });
}

export function emitPluginAuditSecurityEvent(params: {
  outcome: "denied" | "error";
  reason: PluginAuditReason;
  pluginId?: string;
  mode?: PluginSecurityMode;
  sourceFamily?: PluginSecuritySourceFamily;
}) {
  emitTrustedSecurityEvent({
    category: "plugin",
    action: "plugin.audit.failed",
    outcome: params.outcome,
    severity: params.outcome === "error" ? "high" : "medium",
    actor: {
      kind: "operator",
    },
    target: {
      kind: "plugin",
      ...(params.pluginId ? { name: params.pluginId } : {}),
    },
    policy: {
      id: "plugin.install",
      decision: "deny",
      reason: params.reason,
    },
    control: {
      id: "plugin.install.audit",
      family: "supply_chain",
    },
    reason: params.reason,
    attributes: {
      ...(params.sourceFamily ? { source_family: params.sourceFamily } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
    },
  });
}
