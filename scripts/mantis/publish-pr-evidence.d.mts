#!/usr/bin/env node
/**
 * Loads and validates an evidence manifest from disk.
 */
export type EvidenceArtifact = {
  alt?: string;
  inline?: boolean;
  kind: string;
  label: string;
  lane: string;
  path?: string;
  required?: boolean;
  source: string;
  targetPath: string;
  width?: number;
};
export type EvidenceManifest = {
  artifacts: EvidenceArtifact[];
  comparison: {
    baseline?: Record<string, unknown>;
    candidate: Record<string, unknown> & { sha?: string };
    pass?: boolean;
  };
  id: string;
  manifestDir: string;
  scenario: string;
  schemaVersion: number;
  summary?: string;
  title: string;
};
export function loadEvidenceManifest(manifestPath: string): EvidenceManifest;
export function shouldPublishPrComment(
  manifest: EvidenceManifest,
  { requestSource }?: { requestSource?: string },
): boolean;
export function renderEvidenceComment({
  artifactUrl: actionsArtifactUrl,
  manifest,
  marker,
  rawBase,
  requestSource,
  runUrl,
  treeUrl,
}: {
  artifactUrl?: string;
  artifactRoot?: string;
  manifest: EvidenceManifest;
  marker: string;
  rawBase: string;
  requestSource?: string;
  runUrl?: string;
  treeUrl?: string;
}): string;
export function publishArtifactFiles({
  artifactRoot,
  fetchImpl,
  manifest,
  storageConfig,
  timeoutMs,
}: {
  artifactRoot: string;
  fetchImpl?:
    | ((
        url: URL,
        init: { body: Buffer; headers: HeadersInit; method: string; signal: AbortSignal },
      ) => Promise<Response>)
    | undefined;
  manifest: EvidenceManifest;
  storageConfig?:
    | {
        accessKeyId: string;
        bucket: string;
        endpoint: string;
        publicBaseUrl: string;
        region: string;
        secretAccessKey: string;
      }
    | undefined;
  timeoutMs?: number | undefined;
}): Promise<{
  artifactRoot: string;
  rawBase: string;
  treeUrl: string;
}>;
export function publishEvidence(rawArgs?: string[]): Promise<void>;
