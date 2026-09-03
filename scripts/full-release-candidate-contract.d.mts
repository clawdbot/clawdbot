export interface FullReleaseCandidateRecord {
  [key: string]: unknown;
}

export interface FullReleaseCandidateRequest {
  allowFrozenTargetScenarioOmissions: boolean;
  allowUnreleasedChangelog: boolean;
  contractVersions: {
    package: 1;
    prepublishPluginRegistry: 1;
    sharedImage: 1;
  };
  releaseProfile: string;
  releaseSoak: boolean;
  repository: string;
  schema: "openclaw.full-release-candidate-request/v1";
  sharedImagePolicy: string;
  targetSha: string;
  toolingSha: string;
  upgradeSurvivorBaselines: string[];
  upgradeSurvivorScenarios: string[];
}

export interface FullReleaseCandidateArtifactIdentity {
  digest: string;
  expiresAt: string;
  id: string;
  name: string;
  runAttempt: string;
  runId: string;
}

export interface FullReleaseCandidateJobIdentity {
  jobId: string;
  jobName: string;
  repository: string;
  runAttempt: string;
  runId: string;
  workflowPath: string;
  workflowSha: string;
}

export type FullReleaseCandidateProducer = FullReleaseCandidateJobIdentity;

export type FullReleaseCandidatePublisher = FullReleaseCandidateJobIdentity;

export interface FullReleaseCandidatePreparation {
  planSha256: string;
  requiredPrepublishPluginPackages: string[];
}

export interface FullReleaseCandidatePackage {
  artifact: FullReleaseCandidateArtifactIdentity;
  fileName: string;
  packageSha256: string;
  sourceSha: string;
  version: string;
}

export interface FullReleaseCandidatePluginRegistry {
  artifact: FullReleaseCandidateArtifactIdentity;
  manifestSha256: string;
  sourceSha: string;
}

export interface FullReleaseCandidateSharedImage {
  archiveSha256: string;
  artifact: FullReleaseCandidateArtifactIdentity;
  packageSha256: string;
}

export interface FullReleaseCandidateManifest {
  package: FullReleaseCandidatePackage;
  preparation: FullReleaseCandidatePreparation;
  prepublishPluginRegistry: FullReleaseCandidatePluginRegistry;
  producer: FullReleaseCandidateProducer;
  publisher: FullReleaseCandidatePublisher;
  request: FullReleaseCandidateRequest;
  requestSha256: string;
  schema: "openclaw.full-release-candidate/v2";
  sharedImage: FullReleaseCandidateSharedImage;
}

export interface FullReleaseCandidateBinding extends Omit<FullReleaseCandidateManifest, "schema"> {
  evidenceArtifact: FullReleaseCandidateArtifactIdentity;
  manifestSha256: string;
  schema: "openclaw.full-release-candidate-binding/v2";
}

export function buildFullReleaseCandidateRequest(
  input: FullReleaseCandidateRecord,
): FullReleaseCandidateRequest;
export function buildFullReleaseCandidateBinding(input: {
  artifact: FullReleaseCandidateRecord;
  manifest: FullReleaseCandidateRecord;
}): FullReleaseCandidateBinding;
export function canonicalFullReleaseCandidateRequestJson(value: unknown): string;
export function candidateRequestSha256(value: unknown): string;
export function fullReleaseCandidateArtifactName(requestSha256: string): string;
export function validateFullReleaseCandidateRequest(value: unknown): FullReleaseCandidateRequest;
export function validateFullReleaseCandidateBinding(value: unknown): FullReleaseCandidateBinding;
