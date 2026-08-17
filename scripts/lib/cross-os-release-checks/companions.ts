import { resolve } from "node:path";
import { validatePrepublishPluginRegistryArtifact } from "../../prepublish-plugin-registry-artifact.mjs";

type CrossOsCompanionPackage = {
  name: string;
  tarballPath: string;
};

export function resolveCrossOsCompanionPackages(params: {
  artifactDir: string;
  candidateVersion: string;
  manifestSha256: string;
  requiredPackages: string[];
  sourceSha: string;
}): CrossOsCompanionPackage[] {
  const artifactDir = resolve(params.artifactDir);
  const { manifest } = validatePrepublishPluginRegistryArtifact({
    artifactDir,
    expectedCandidateVersion: params.candidateVersion,
    expectedManifestSha256: params.manifestSha256,
    expectedSourceSha: params.sourceSha,
    requiredPackages: params.requiredPackages,
  });
  const requiredPackages = new Set(params.requiredPackages);
  return manifest.packages
    .filter((entry: { name: string; tarball: string }) => requiredPackages.has(entry.name))
    .map((entry: { name: string; tarball: string }) => ({
      name: entry.name,
      tarballPath: resolve(artifactDir, entry.tarball),
    }));
}
