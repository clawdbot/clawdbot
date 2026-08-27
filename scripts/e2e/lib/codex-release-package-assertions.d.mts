export type CodexReleasePackageEvidence = {
  packageVersion: string;
  cliVersion: string;
  platformAlias: string;
  platformVersion: string;
  platformOs: string;
  platformCpu: string;
};

export function assertCodexReleasePackageContract(params: {
  pluginPackageJson: string;
  codexPackageJson: string;
  packageRoots: string[];
  managedRoot: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  recordEvidence?: boolean;
}): {
  codexBin: string;
  evidence: CodexReleasePackageEvidence;
};
