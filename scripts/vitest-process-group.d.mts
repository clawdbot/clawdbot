export function shouldUseDetachedVitestProcessGroup(
  platform?: NodeJS.Platform,
): platform is
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "cygwin"
  | "netbsd";
/**
 * Resolves the PID or process-group target for Vitest signal forwarding.
 */
export function resolveVitestProcessGroupSignalTarget(params: unknown): number | null;
/**
 * Forwards a signal to the Vitest child or process group.
 */
export function forwardSignalToVitestProcessGroup(params: unknown): boolean;
/**
 * Force-cleans unknown remaining processes in a Vitest child process group.
 */
export function forceKillVitestProcessGroup(
  child: unknown,
  kill?: (pid: number, signal?: string | number) => true,
): boolean;
/**
 * Installs signal/exit cleanup handlers for a Vitest child process group.
 */
export function installVitestProcessGroupCleanup(params: unknown): () => void;
