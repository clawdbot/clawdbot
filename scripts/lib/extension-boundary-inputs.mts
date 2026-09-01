import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { resolveRepoToolBinPath } from "./local-check-runtime.mts";

export const LOCAL_SDK_ROOT = "packages/plugin-sdk/dist";
export const BOUNDARY_CACHE_ROOT = ".artifacts/extension-package-boundary";
export const LOCAL_PLUGIN_ROOT = `${BOUNDARY_CACHE_ROOT}/plugins`;
export const BOUNDARY_PLUGIN_UNITS = [
  ["qa-channel", "api"],
  ["memory-core", "api"],
  ["matrix", "test-api"],
  ["discord", "api"],
  ["slack", "api"],
  ["telegram", "api"],
  ["whatsapp", "api"],
] as const;

const GENERATOR_INPUTS = [
  "pnpm-lock.yaml",
  "package.json",
  "node_modules/.modules.yaml",
  "scripts/lib/extension-boundary-inputs.mts",
  "scripts/lib/compiler-input-snapshot.mts",
  "scripts/lib/build-artifact-cache.mts",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/dist-artifact-ownership.mts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/repo-root.mjs",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/plugin-sdk-entries.mts",
  "scripts/lib/plugin-sdk-entrypoints.json",
  "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
  "scripts/prepare-extension-package-boundary-artifacts.mts",
  "scripts/check-extension-package-tsc-boundary.mts",
  "scripts/run-tsgo.mjs",
  "scripts/run-tsgo.mts",
];
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(resolveRepoToolBinPath("tsgo"));
const nativePackage = nativeRequire.resolve("@typescript/native-preview/package.json");
const nativeBinary: string = nativeRequire(
  path.join(path.dirname(nativePackage), "lib/getExePath.js"),
).default();
const libraryRoot = path.dirname(fs.realpathSync(nativeBinary));
const toolchainFiles = [
  nativePackage,
  nativeBinary,
  path.join(path.dirname(nativePackage), "lib/tsgo.js"),
  path.join(path.dirname(nativePackage), "lib/getExePath.js"),
  require.resolve("typescript"),
  require.resolve("typescript/package.json"),
];

/** Native build-info adapts successful membership to the shared snapshot policy. */
export class BoundaryInputSnapshot extends CompilerInputSnapshot {
  constructor(rootDir: string) {
    super(rootDir, { toolchainFiles, generatorInputs: GENERATOR_INPUTS });
  }

  record(
    config: string,
    args: string[],
    buildInfo: string,
    outputs: string[],
    before: BoundaryInputSnapshot,
    startedAt: number,
    outputRoot?: string,
  ): ArtifactRecord {
    const info: { fileNames: string[]; fileInfos: unknown[]; packageJsons?: string[] } = JSON.parse(
      fs.readFileSync(path.resolve(this.rootDir, buildInfo), "utf8"),
    );
    const directory = path.dirname(path.resolve(this.rootDir, buildInfo));
    const inputs = [
      ...new Set([
        ...info.fileNames
          .slice(0, info.fileInfos.length)
          .map((file) =>
            path.resolve(
              file.startsWith("lib.") && !file.includes("/") ? libraryRoot : directory,
              file,
            ),
          ),
        ...(info.packageJsons ?? []).map((file) => path.resolve(directory, file)),
      ]),
    ]
      .map((file) => portableRelativePath(this.rootDir, file))
      .toSorted();
    return {
      version: ARTIFACT_CACHE_VERSION,
      ...this.seal(config, args, inputs, before, startedAt, outputRoot),
      outputs: Object.fromEntries(outputs.map((file) => [file, this.hash(file)])),
    };
  }
}
