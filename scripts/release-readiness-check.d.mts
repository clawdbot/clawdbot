#!/usr/bin/env node

export interface ReleaseReadinessStage {
  id: string;
  command: string;
  args: string[];
}

export interface ReleaseReadinessStageResult {
  id: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

export const RELEASE_READINESS_STAGES: ReleaseReadinessStage[];

export function runReleaseReadiness(
  stages?: ReleaseReadinessStage[],
  options?: {
    concurrency?: number;
    runStage?: (stage: ReleaseReadinessStage) => Promise<ReleaseReadinessStageResult>;
  },
): Promise<{
  schemaVersion: 1;
  status: "passed" | "failed";
  durationMs: number;
  stages: ReleaseReadinessStageResult[];
}>;
