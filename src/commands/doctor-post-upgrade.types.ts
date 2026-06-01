export type PostUpgradeFindingLevel = "ok" | "warn" | "error";

export type PostUpgradeFinding = {
  level: PostUpgradeFindingLevel;
  code: string;
  message: string;
  plugin?: string;
  entry?: string;
};

export type PostUpgradeReport = {
  probesRun: string[];
  findings: PostUpgradeFinding[];
};

export const POST_UPGRADE_PROBE_CODES = [
  "plugin.index_unavailable",
  "plugin.entry_unresolved",
  "plugin.manifest_drift",
] as const;

export type PostUpgradeProbeCode = (typeof POST_UPGRADE_PROBE_CODES)[number];
