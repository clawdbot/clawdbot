/**
 * Lists entry-shim artifacts written by scripts/write-plugin-sdk-entry-dts.ts.
 */
export function resolveBoundaryEntryShimRequiredOutputs(env?: NodeJS.ProcessEnv): string[];
/**
 * Parses the artifact preparation mode from CLI arguments.
 */
export function parseMode(argv?: string[]): string;
/**
 * Reads the root shim timeout override for long package-boundary builds.
 */
export function resolveBoundaryRootShimsTimeoutMs(env?: NodeJS.ProcessEnv): number;
/**
 * Compares input and output mtimes to skip fresh generated artifacts.
 */
export function isArtifactSetFresh(params: unknown): boolean;
/**
 * Prefixes streamed child output line-by-line without breaking partial chunks.
 */
export function createPrefixedOutputWriter(
  label: unknown,
  target: unknown,
): {
  write(chunk: unknown): void;
  flush(): void;
};
export function signalNodeStep(
  child: unknown,
  signal: unknown,
  {
    platform,
    runTaskkill,
    useProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((command: string, args?: string[]) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  },
): void;
/**
 * Runs one artifact step with timeout, abort propagation, and prefixed output.
 */
export function runNodeStep(
  label: unknown,
  args: unknown,
  timeoutMs: unknown,
  params?: Record<string, unknown>,
): Promise<unknown>;
/**
 * Runs independent artifact steps together and aborts siblings on first failure.
 */
export function runNodeStepsInParallel(steps: unknown): Promise<void>;
/**
 * Chooses serial or parallel artifact execution based on local heavy-check policy.
 */
export function runNodeSteps(steps: unknown, env?: NodeJS.ProcessEnv): Promise<void>;
import { spawnSync } from "node:child_process";
