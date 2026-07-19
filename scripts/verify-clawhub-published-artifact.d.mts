#!/usr/bin/env node
export class PermanentReadbackError extends Error {}
export class RetryableReadbackError extends Error {
  retryAfterMs: number | undefined;
  constructor(message: string, requestedDelayMs?: number);
}
export function verifyPublishedClawHubArtifacts(options: unknown): Promise<{
  schemaVersion: number;
  repository: unknown;
  targetSha: unknown;
  workflowSha: unknown;
  runId: unknown;
  producerRunAttempt: string;
  terminalRunAttempt: string;
  artifactName: unknown;
  artifactId: string;
  artifactDigest: unknown;
  clawhubToolchainIntegrity: unknown;
  clawhubToolchainSha256: unknown;
  clawhubToolchainVersion: unknown;
  requestedPlugins: unknown[];
  verificationMode: unknown;
  packages: unknown[];
}>;
export function verifyPublishedClawHubPackage(options: unknown): Promise<{
  schemaVersion: number;
  verificationMode: string;
  expectedArtifact: {
    sha256: string;
    size: unknown;
    npmIntegrity: string;
    npmShasum: string;
    fileName: string;
  };
  package: unknown;
}>;
