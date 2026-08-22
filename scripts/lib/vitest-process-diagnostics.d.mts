import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import type fs from "node:fs";

type SpawnSyncImpl = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type VitestProcessDiagnosticsParams = {
  pid: number | undefined;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: SpawnSyncImpl;
  fsImpl?: Pick<typeof fs, "existsSync">;
};

export declare function collectVitestProcessDiagnostics(
  params: VitestProcessDiagnosticsParams,
): string[];

export declare function writeVitestProcessDiagnostics(
  params: VitestProcessDiagnosticsParams & {
    log?: (message: string) => void;
  },
): void;
