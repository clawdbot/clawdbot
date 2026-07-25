export type VitestBatchRunParams = {
  args: string[];
  config: string;
  env?: NodeJS.ProcessEnv;
  targets: string[];
};

export function runVitestBatch(params: VitestBatchRunParams): Promise<number>;
export function buildVitestBatchPnpmArgs(params: VitestBatchRunParams): string[];
export function isDirectScriptRun(metaUrl: string): boolean;
