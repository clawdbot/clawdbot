import type { ExtensionBatchPlan } from "./lib/extension-test-plan.mjs";
import type { VitestBatchRunParams } from "./lib/vitest-batch-runner.mjs";

export function parseExtensionIds(rawArgs: string[]): string[];
export function resolveExtensionBatchParallelism(
  groupCount: number,
  env?: NodeJS.ProcessEnv,
): number;
export function parseExactVitestExcludePaths(vitestArgs: string[]): string[];
export function runExtensionBatchPlan(
  batchPlan: ExtensionBatchPlan,
  params?: {
    allowEmptyAfterExclude?: boolean;
    env?: NodeJS.ProcessEnv;
    runGroup?: (params: VitestBatchRunParams) => Promise<number>;
    vitestArgs?: string[];
  },
): Promise<number>;
