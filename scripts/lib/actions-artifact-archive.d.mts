export const ACTIONS_ARTIFACT_API_VERSION: "2026-03-10";
export const DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES: number;
export const DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES: number;

export type ArtifactArchivePolicy = {
  expectedEntries?: readonly string[];
  minEntries?: number;
  maxEntries?: number;
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
  rejectCaseFoldAliases?: boolean;
  allowPath?: (name: string) => boolean;
  maxCompressedEntryBytes?: (name: string) => number;
  maxEntryBytes: (name: string) => number;
};

export type ArtifactBinding = {
  artifactDigest: string;
  artifactId: number;
  artifactName: string;
  artifactSizeBytes: number;
  repository: string;
  runStatePolicy: "completed-success" | "same-run-producer-success";
  runAttempt: number;
  runId: number;
  workflowEvent: string;
  workflowHeadBranch: string;
  workflowPath: string;
  workflowSha: string;
  consumerRunAttempt?: number;
  producerJobName?: string;
};

export type ArtifactFileDescription = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

type ArtifactDownloadParams = {
  expected: ArtifactBinding;
  fetchImpl?: typeof fetch;
  maxArchiveBytes?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  token: string;
};

type ArtifactDownloadResult = {
  archiveBytes: Uint8Array;
  artifactMetadata: Record<string, unknown>;
  binding: ArtifactBinding;
  workflowJobs: Record<string, unknown> | undefined;
  workflowRun: Record<string, unknown>;
};

export function sha256Digest(bytes: Uint8Array): string;
export function describeActionsArtifactFiles(
  files: Map<string, Uint8Array>,
): ArtifactFileDescription[];
export function readBoundedRegularFile(
  path: string,
  params: { label: string; maxBytes: number },
): Buffer;
export function inspectActionsArtifactZipWithPolicy(
  inputBytes: Uint8Array,
  inputPolicy: ArtifactArchivePolicy,
): Map<string, Buffer>;
export function inspectActionsArtifactZip(
  bytes: Uint8Array,
  expectedEntries?: number | readonly string[],
  limits?: {
    maxArchiveBytes?: number;
    maxExpandedBytes?: number;
    maxCompressedEntryBytes?: number;
    maxEntryBytes?: number;
  },
): Map<string, Buffer>;
export function validateActionsArtifactBinding(params: {
  artifactMetadata: unknown;
  expected: ArtifactBinding;
  workflowRun: unknown;
}): ArtifactBinding;
export function validateActionsArtifactProducerJob(params: {
  expected: ArtifactBinding;
  workflowJobs: unknown;
}): ArtifactBinding;
export function downloadActionsArtifactArchive(
  params: ArtifactDownloadParams,
): Promise<ArtifactDownloadResult>;
export function readPublicationArtifactArchive(
  params: ArtifactDownloadParams & { archivePolicy: ArtifactArchivePolicy },
): Promise<ArtifactDownloadResult & { files: Map<string, Buffer> }>;
