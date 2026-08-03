/**
 * Detects help requests before the command separator.
 */
export function isRunWithEnvHelpRequest(argv: unknown): boolean;
/**
 * Parses KEY=value assignments and the command following --.
 */
export function parseRunWithEnvArgs(argv: unknown): {
  env: Record<string, unknown>;
  command: unknown;
  args: unknown;
};
/**
 * Resolves bare Node command names to the current executable so wrapper and child use the same
 * runtime. Windows command lookup is case-insensitive; explicit paths remain caller-owned.
 */
export function resolveSpawnCommand(
  command: unknown,
  args: unknown,
  execPath?: string,
  platform?: NodeJS.Platform,
): {
  command: unknown;
  args: unknown;
};
/**
 * Reads the signal-forwarding force-kill grace period.
 */
export function resolveForceKillDelayMs(env?: NodeJS.ProcessEnv): number;
/**
 * Signals the wrapped command tree when this small parent wrapper is stopped.
 */
export function signalRunWithEnvChild(
  child: unknown,
  signal: unknown,
  {
    platform,
    runTaskkill,
    useChildProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((command: string, args?: string[]) => { error?: Error; status: number | null })
      | undefined;
    useChildProcessGroup?: boolean | undefined;
  },
): void;
import { spawnSync } from "node:child_process";
