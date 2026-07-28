import type fs from "node:fs";

export type StaticExtensionAsset = {
  pluginDir?: string;
  src: string;
  dest: string;
};

export type RuntimePostBuildParams = {
  rootDir?: string;
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  timings?: boolean | "verbose";
  warn?: (message: string) => void;
};

type StaticExtensionAssetParams = Pick<RuntimePostBuildParams, "rootDir" | "fs" | "warn"> & {
  assets?: StaticExtensionAsset[];
};

type LegacyCliExitCompatChunk = { dest: string; contents: string };

export function listStaticExtensionAssetOutputs(params?: StaticExtensionAssetParams): string[];

export function listCoreRuntimePostBuildOutputs(
  params?: Pick<RuntimePostBuildParams, "rootDir" | "fs"> & {
    chunks?: LegacyCliExitCompatChunk[];
  },
): string[];
export function writeStableRootRuntimeAliases(
  params?: Pick<RuntimePostBuildParams, "rootDir" | "fs">,
): void;
export function rewriteRootRuntimeImportsToStableAliases(
  params?: Pick<RuntimePostBuildParams, "rootDir" | "fs">,
): void;
export function writeLegacyRootRuntimeCompatAliases(
  params?: Pick<RuntimePostBuildParams, "rootDir" | "fs">,
): void;
export function writeLegacyCliExitCompatChunks(params?: {
  rootDir?: string;
  chunks?: LegacyCliExitCompatChunk[];
}): void;
export function runRuntimePostBuild(params?: RuntimePostBuildParams): void;
