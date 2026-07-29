export type LegacyWorkspaceStateSource = {
  kind: "setup" | "attestation";
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  workspaceKey: string;
  workspaceDir?: string;
  workspaceAliasPath?: string;
  priority: number;
};

export type LegacyWorkspaceStateDetection = {
  sources: LegacyWorkspaceStateSource[];
  hasLegacy: boolean;
};
