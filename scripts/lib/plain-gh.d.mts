import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
  ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

type ExecGhReadImpl = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
) => string | Uint8Array<ArrayBuffer>;

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
): Uint8Array<ArrayBuffer>;
export function execPlainGh(
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Uint8Array<ArrayBuffer>;
export function execGhRead(
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
  params?: { execFileSyncImpl?: ExecGhReadImpl },
): string;
export function execGhRead(
  args: readonly string[],
  options?: ExecFileSyncOptionsWithBufferEncoding,
  params?: { execFileSyncImpl?: ExecGhReadImpl },
): Uint8Array<ArrayBuffer>;
export function execGhRead(
  args: readonly string[],
  options?: ExecFileSyncOptions,
  params?: { execFileSyncImpl?: ExecGhReadImpl },
): string | Uint8Array<ArrayBuffer>;
export function execGhJson(
  args: readonly string[],
  options?: ExecFileSyncOptions,
  params?: { execFileSyncImpl?: ExecGhReadImpl },
): unknown;
export function execGhApiRead(
  endpoint: string,
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execGhApiRead(
  endpoint: string,
  options?: ExecFileSyncOptionsWithBufferEncoding,
): Uint8Array<ArrayBuffer>;
export function execGhApiRead(
  endpoint: string,
  options?: ExecFileSyncOptions,
): string | Uint8Array<ArrayBuffer>;
export const PLAIN_GH_SYSTEM_CANDIDATES: string[];
