import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
  ExecFileSyncOptionsWithStringEncoding,
  SpawnSyncOptions,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

export function plainGhEnv(env?: NodeJS.ProcessEnv): {
  [key: string]: string | undefined;
};
export function resolvePlainGhBin(env?: NodeJS.ProcessEnv, systemCandidates?: string[]): string;
export function execPlainGh(
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execPlainGh(
  args: readonly string[],
  options?: ExecFileSyncOptionsWithBufferEncoding,
): NonSharedBuffer;
export function execPlainGh(
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | NonSharedBuffer;
export function spawnPlainGh(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnPlainGh(
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<NonSharedBuffer>;
export function spawnPlainGh(
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | NonSharedBuffer>;
export const PLAIN_GH_SYSTEM_CANDIDATES: string[];
