export type RegistryResult = {
  status: number;
  packument: Record<string, unknown> | null;
};

export type PlaceholderEntry = {
  packageDir: string;
  packageName: string;
  sourcePackageJsonSha256: string;
  action: "publish" | "skip" | "tag";
  newPackage: boolean;
  preExistingDistTags: Record<string, string>;
  tarball: {
    name: string;
    integrity: string;
    sha256: string;
    shasum: string;
    sizeBytes: number;
  };
};

export function createPlaceholderTarball(packageName: string): Buffer;
export function parseSelectedPackages(input: string): string[];
export function resolveSelectedPackageSources(
  repoRoot: string,
  packageNames: string[],
): Array<{
  packageDir: string;
  packageName: string;
  sourcePackageJsonSha256: string;
}>;
export function classifyRegistryState(params: {
  expectedIntegrity: string;
  expectedShasum: string;
  packageName: string;
  registry: RegistryResult;
}): {
  action: "publish" | "skip" | "tag";
  newPackage: boolean;
  nonPlaceholderTags: Record<string, string>;
};
export function createPlaceholderPublication(params: {
  repoRoot: string;
  outputDir: string;
  packages: string;
  targetSha: string;
  workflowSha: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  schema: string;
  targetSha: string;
  workflowPath: string;
  workflowSha: string;
  version: string;
  publishTag: string;
  packages: PlaceholderEntry[];
}>;
export function verifyPlaceholderArtifact(params: Record<string, unknown>): Promise<{
  artifactSha256: string;
  manifest: Record<string, unknown>;
}>;
export function assertFinalRegistryState(entry: PlaceholderEntry, registry: RegistryResult): void;
export function publishPlaceholders(params: {
  artifactDir: string;
  npmToken: string;
  targetSha: string;
  workflowSha: string;
  fetchImpl?: typeof fetch;
  npmRunner?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => void;
  registryAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  tempRoot?: string;
}): Promise<{
  results: Array<{
    action: "publish" | "skip" | "tag";
    newPackage: boolean;
    packageName: string;
  }>;
}>;
export function main(argv?: string[]): Promise<void>;
