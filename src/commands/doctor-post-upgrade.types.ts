/** Shared report types for post-upgrade doctor plugin probes. */
type PostUpgradeFindingLevel = "ok" | "warn" | "error";

/** One post-upgrade validation finding, optionally tied to a plugin package entry. */
export type PostUpgradeFinding = {
  level: PostUpgradeFindingLevel;
  code: string;
  message: string;
  plugin?: string;
  entry?: string;
};

/** Structured post-upgrade probe report returned by the probe runner. */
export type PostUpgradeReport = {
  probesRun: string[];
  findings: PostUpgradeFinding[];
};

/** Probe codes emitted by post-upgrade validation. */
export const POST_UPGRADE_PROBE_CODES = [
  "plugin.index_unavailable",
  "plugin.entry_unresolved",
  "plugin.manifest_drift",
] as const;
