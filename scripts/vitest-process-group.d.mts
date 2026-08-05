import type { ChildProcess } from "node:child_process";

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
 * Resolves only after the child completion contract and any owned POSIX group are joined.
 */
export function createVitestProcessCompletion(params: {
  child: ChildProcess;
  detached: boolean;
  kill?: (pid: number, signal?: string | number) => true;
  platform?: NodeJS.Platform;
}): Promise<{ code: number | null; signal: ChildProcess["signalCode"] }>;
/**
 * Installs signal/exit cleanup handlers for a Vitest child process group.
 */
export function installVitestProcessGroupCleanup(params: unknown): () => void;
