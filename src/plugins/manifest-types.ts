/** UI hint metadata for plugin config schema fields. */
export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

/** Top-level plugin manifest format. */
export type PluginFormat = "openclaw" | "bundle";

/** Supported external bundle manifest formats. */
export type PluginBundleFormat = "codex" | "claude" | "cursor";

/**
 * Closed classification codes for plugin diagnostics. Health surfaces branch
 * on these instead of matching freeform diagnostic message text.
 */
export type PluginDiagnosticCode =
  | "channel-setup-failure"
  | "dashboard-declaration-invalid"
  | "plugin-verification";

/** Diagnostic emitted while discovering or validating plugins. */
export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
  code?: PluginDiagnosticCode;
};
