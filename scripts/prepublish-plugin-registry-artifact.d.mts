export const PREPUBLISH_PLUGIN_REGISTRY_MANIFEST: "prepublish-plugin-registry.json";
export function validatePrepublishPluginRegistryArtifact(params: {
  artifactDir: string;
  expectedCandidateVersion: string;
  expectedManifestSha256: string;
  expectedSourceSha: string;
  requiredPackages: string[];
}): {
  manifest: {
    schema: string;
    schemaVersion: number;
    sourceSha: string;
    candidateVersion: string;
    packages: Array<{
      name: string;
      version: string;
      tarball: string;
      sha256: string;
    }>;
  };
  manifestPath: string;
  manifestSha256: string;
};
export function createPrepublishPluginRegistryArtifact(params: {
  repoRoot: string;
  outputDir: string;
  sourceSha: string;
  candidateVersion: string;
  requiredPackages: string[];
}): ReturnType<typeof validatePrepublishPluginRegistryArtifact>;
