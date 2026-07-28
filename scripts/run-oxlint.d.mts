/**
 * Returns whether oxlint args need package-boundary declaration artifacts first.
 */
export function shouldPrepareExtensionPackageBoundaryArtifacts(args: unknown): boolean;
/**
 * Drops tracked-but-missing sparse-checkout targets so narrow sparse checks can pass.
 */
export function filterSparseMissingOxlintTargets(
  args: string[],
  {
    cwd,
    fileExists,
    isSparseCheckoutEnabled,
    isTrackedPath,
  }?: {
    cwd?: string | undefined;
    fileExists?: ((target: string) => boolean) | undefined;
    isSparseCheckoutEnabled?: ((params: { cwd: string }) => boolean) | undefined;
    isTrackedPath?: ((params: { cwd: string; target: string }) => boolean) | undefined;
  },
): {
  args: string[];
  hadExplicitTargets: boolean;
  remainingExplicitTargets: number;
  skippedTargets: string[];
  skippedConfigs: string[];
};
/**
 * Applies wrapper policy and runs oxlint with the final argument list.
 */
export function main(argv?: string[], runtimeEnv?: NodeJS.ProcessEnv): Promise<void>;
/**
 * CLI entry: converts wrapper crashes into exit 1 and ends every failing run
 * with a stable `[oxlint] FAILED (exit N)` final line.
 */
export function runOxlintCliEntry(
  run?: () => Promise<void>,
  log?: (message: unknown) => void,
): Promise<void>;
