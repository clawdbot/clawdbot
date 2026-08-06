#!/usr/bin/env node
export function inspectPackageTarballBytes(
  inputBytes: unknown,
  options?: Record<string, unknown>,
): {
  inventory: (
    | {
        path: string;
        sha256: string;
        sizeBytes: unknown;
        type: string;
      }
    | {
        path: string;
        sizeBytes: number;
        type: string;
      }
  )[];
  packageManifest: unknown;
  packageManifestSha256: string;
  pluginManifest: unknown;
  pluginManifestSha256: string;
  tarballSizeBytes: number;
  tarballSha256: string;
  totalFileBytes: number;
};
export function validatePluginPackageManifest(params: unknown, packageManifest: unknown): void;
export function createPluginPublicationArtifact(params: unknown): {
  manifest: {
    schema: string;
    schemaVersion: number;
    targetSha: unknown;
    package: {
      dir: unknown;
      name: unknown;
      version: unknown;
      author: unknown;
      contributors: unknown;
      repository: unknown;
      packageJsonSha256: unknown;
      pluginManifestSha256: unknown;
      sourcePackageJsonSha256: unknown;
    };
    publication:
      | {
          route: unknown;
          authMode: unknown;
          capability: unknown;
          reason: unknown;
          tag: unknown;
          publisherPolicy: unknown;
          bootstrapMode?: undefined;
          manualOverrideReason?: undefined;
          requiresManualOverride?: undefined;
        }
      | {
          route: unknown;
          tag: unknown;
          bootstrapMode: unknown;
          manualOverrideReason: unknown;
          requiresManualOverride: unknown;
          authMode?: undefined;
          capability?: undefined;
          reason?: undefined;
          publisherPolicy?: undefined;
        };
    artifact: {
      name: unknown;
      tarball: unknown;
      npmIntegrity: string;
      npmShasum: string;
      sha256: unknown;
      sizeBytes: unknown;
      inventory: unknown;
    };
  };
  manifestPath: string;
  tarballPath: string;
};
export function verifyPluginPublicationArtifact(params: unknown): {
  artifactDigest: string;
  artifactId: unknown;
  artifactName: string;
  artifactSizeBytes: unknown;
  artifactZipSha256: string;
  manifest: {
    schema: string;
    schemaVersion: number;
    targetSha: unknown;
    package: {
      dir: unknown;
      name: unknown;
      version: unknown;
      author: unknown;
      contributors: unknown;
      repository: unknown;
      packageJsonSha256: unknown;
      pluginManifestSha256: unknown;
      sourcePackageJsonSha256: unknown;
    };
    publication:
      | {
          route: unknown;
          authMode: unknown;
          capability: unknown;
          reason: unknown;
          tag: unknown;
          publisherPolicy: unknown;
          bootstrapMode?: undefined;
          manualOverrideReason?: undefined;
          requiresManualOverride?: undefined;
        }
      | {
          route: unknown;
          tag: unknown;
          bootstrapMode: unknown;
          manualOverrideReason: unknown;
          requiresManualOverride: unknown;
          authMode?: undefined;
          capability?: undefined;
          reason?: undefined;
          publisherPolicy?: undefined;
        };
    artifact: {
      name: unknown;
      tarball: unknown;
      npmIntegrity: string;
      npmShasum: string;
      sha256: unknown;
      sizeBytes: unknown;
      inventory: unknown;
    };
  };
  npmIntegrity: string;
  npmShasum: string;
  packageJsonSha256: unknown;
  pluginManifestSha256: unknown;
  producerRunAttempt: unknown;
  producerRunId: unknown;
  sourcePackageJsonSha256: unknown;
  tarballInventory: (
    | {
        path: string;
        sha256: string;
        sizeBytes: unknown;
        type: string;
      }
    | {
        path: string;
        sizeBytes: number;
        type: string;
      }
  )[];
  tarballName: string;
  tarballPath: string;
  tarballSizeBytes: number;
  tarballSha256: string;
};
export function main(argv?: string[]): void;
export const CLAWHUB_PUBLICATION_TAR_LIMITS: Readonly<{
  maxArchiveBytes: number;
  maxEntries: 10000;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxPathBytes: number;
  maxTotalFileBytes: number;
}>;
import { downloadActionsArtifactArchive } from "./lib/actions-artifact-archive.mjs";
import { describeActionsArtifactFiles } from "./lib/actions-artifact-archive.mjs";
import { inspectActionsArtifactZip } from "./lib/actions-artifact-archive.mjs";
import { inspectActionsArtifactZipWithPolicy } from "./lib/actions-artifact-archive.mjs";
import { readBoundedRegularFile } from "./lib/actions-artifact-archive.mjs";
import { readPublicationArtifactArchive } from "./lib/actions-artifact-archive.mjs";
import { validateActionsArtifactBinding } from "./lib/actions-artifact-archive.mjs";
import { validateActionsArtifactProducerJob } from "./lib/actions-artifact-archive.mjs";
export {
  downloadActionsArtifactArchive,
  describeActionsArtifactFiles,
  inspectActionsArtifactZip,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  readPublicationArtifactArchive,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
};
