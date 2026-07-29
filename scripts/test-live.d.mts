export type TestLiveArgs = {
  forceCodexHarness: boolean;
  forwardedArgs: string[];
  help: boolean;
  quietOverride: string | undefined;
};
export function parseTestLiveArgs(argv: string[]): TestLiveArgs;
export function buildTestLiveEnv(
  args: TestLiveArgs,
  baseEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function resolveTestLiveHeartbeatMs(baseEnv?: NodeJS.ProcessEnv): number;
export function resolveTestLiveNoOutputTimeoutMs(baseEnv?: NodeJS.ProcessEnv): number | null;
export function buildTestLivePnpmArgs(args: TestLiveArgs): string[];
export function buildTestLiveSpawnParams(
  env: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): {
  detached: boolean;
  env: NodeJS.ProcessEnv;
  stdio: ["inherit", "pipe", "pipe"];
};
export function main(argv?: string[], baseEnv?: NodeJS.ProcessEnv): void;
