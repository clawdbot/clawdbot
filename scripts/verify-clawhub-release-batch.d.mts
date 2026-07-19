#!/usr/bin/env node

export interface ClawHubBatchPlugin {
  artifactName: string;
  packageName: string;
  publishTag: string;
  version: string;
}

export interface ClawHubBatchEvidence {
  schemaVersion: 1;
  status: string;
  packageCount: number;
  durationMs: number;
  packages: Array<{
    artifactName: string;
    packageName: string;
    publishTag: string;
    version: string;
    status: "ready" | "pending" | "failed";
    result?: unknown;
    error?: string;
  }>;
}

export class ClawHubBatchVerificationError extends Error {
  evidence: ClawHubBatchEvidence;
  constructor(message: string, evidence: ClawHubBatchEvidence);
}

export function verifyClawHubReleaseBatch(options: {
  plugins: ClawHubBatchPlugin[];
  artifactsRoot?: string;
  registry?: string;
  attempts?: string | number;
  concurrency?: string | number;
  delayMs?: string | number;
  sleep?: (milliseconds: number) => Promise<void>;
  verify?: (plugin: ClawHubBatchPlugin) => Promise<unknown>;
}): Promise<ClawHubBatchEvidence>;
