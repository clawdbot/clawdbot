/**
 * Detects the package manager running the current lifecycle script.
 */
export function detectLifecyclePackageManager(env?: NodeJS.ProcessEnv): string | null;
/**
 * Builds the warning shown for non-pnpm lifecycle installs.
 */
export function createPackageManagerWarningMessage(packageManager: unknown): string | null;
/**
 * Emits the non-pnpm lifecycle warning when needed.
 */
export function warnIfNonPnpmLifecycle(
  env?: NodeJS.ProcessEnv,
  warn?: (...data: unknown[]) => void,
): boolean;
