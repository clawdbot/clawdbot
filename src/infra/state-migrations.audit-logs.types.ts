export type LegacyAuditLogSource = {
  kind: "config" | "system-agent" | "crestodian";
  label: string;
  sourcePath: string;
  logicalSourcePath: string;
  storage: "active" | "claim" | "raw-archive";
  sanitizedArchivePath?: string;
  rawArchivePath?: string;
};

export type LegacyAuditLogsDetection = {
  sources: LegacyAuditLogSource[];
  hasLegacy: boolean;
};
