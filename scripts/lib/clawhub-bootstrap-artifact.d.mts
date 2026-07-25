export type ClawHubBootstrapEntry = {
  artifactPath: string;
  packageName: string;
  sha256: string;
  size: number;
  version: string;
};
export type ClawHubBootstrapManifest = {
  artifactName: string;
  clawhubToolchainIntegrity: string;
  clawhubToolchainSha256: string;
  clawhubToolchainVersion: string;
  entries: ClawHubBootstrapEntry[];
  repository: string;
  runAttempt: string;
  runId: string;
  targetSha: string;
  workflowSha: string;
};
export function verifyClawHubPackedArtifactIdentity(
  options: Record<string, unknown>,
): Promise<void>;
export function parseClawHubBootstrapManifestBytes(
  inputBytes: Uint8Array,
): ClawHubBootstrapManifest;
export function readClawHubBootstrapManifest(path: string): ClawHubBootstrapManifest;
export function downloadClawHubBootstrapArtifact(
  options: Record<string, unknown>,
): Promise<unknown>;
export function createClawHubBootstrapArtifactManifest(
  options: Record<string, unknown> & {
    artifactRoot: string;
    matrixPath: string;
    outputPath: string;
  },
): Promise<ClawHubBootstrapManifest>;
export function verifyClawHubBootstrapArtifactManifest(
  options: Record<string, unknown> & { artifactRoot: string; manifestPath: string },
): Promise<ClawHubBootstrapManifest>;
