import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import { CompilerInputSnapshot } from "./compiler-input-snapshot.mts";
import { createDeclarationInputBoundary } from "./tsdown-declaration-boundary.mts";

export const LOCAL_SDK_ROOT = "packages/plugin-sdk/dist";
export const BOUNDARY_CACHE_ROOT = ".artifacts/extension-package-boundary";
export const LOCAL_PLUGIN_ROOT = `${BOUNDARY_CACHE_ROOT}/plugins`;
export const BOUNDARY_PLUGIN_UNITS = [
  ["qa-channel", "api"],
  ["memory-core", "api"],
  ["matrix", "test-api"],
  ["discord", "api"],
  ["slack", "test-api"],
  ["telegram", "api"],
  ["whatsapp", "api"],
] as const;

const GENERATOR_INPUTS = [
  "pnpm-lock.yaml",
  "package.json",
  // Pnpm's manifest carries machine-local store metadata. Native membership,
  // installed topology, and input bytes own dependency invalidation here.
  "scripts/lib/extension-boundary-inputs.mts",
  "scripts/lib/compiler-input-snapshot.mts",
  "scripts/lib/tsdown-declaration-boundary.mts",
  "scripts/lib/build-artifact-cache.mts",
  "scripts/lib/bounded-output-tail.mjs",
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
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
/** Native build-info adapts successful membership to the shared snapshot policy. */
export class BoundaryInputSnapshot extends CompilerInputSnapshot {
  private readonly boundary: ReturnType<typeof createDeclarationInputBoundary>;
  private readonly libraryRoot: string;

  constructor(rootDir: string) {
    const boundary = createDeclarationInputBoundary(rootDir);
    const assertInput = (file: string) => boundary.assert(file);
    // Bind compact receipt lib names to this checkout's compiler, never ambient cwd.
    const require = createRequire(path.join(boundary.root, "package.json"));
    const nativePackage = assertInput(require.resolve("@typescript/native-preview/package.json"));
    const nativeRoot = path.dirname(nativePackage);
    const executableResolver = assertInput(path.join(nativeRoot, "lib/getExePath.js"));
    // The native launcher prefixes long Windows executables with \\?\; normalize
    // that syntax without resolving an arbitrary outside candidate into scope.
    const executable: string = require(executableResolver).default();
    const nativeBinary = assertInput(fileURLToPath(pathToFileURL(executable)));
    const platformPackage = createRequire(nativePackage).resolve(
      `@typescript/native-preview-${process.platform}-${process.arch}/package.json`,
    );
    const toolchainFiles = [
      nativePackage,
      platformPackage,
      nativeBinary,
      path.join(boundary.root, "node_modules/.bin/tsgo"),
      path.join(nativeRoot, "bin/tsgo"),
      path.join(nativeRoot, "lib/tsgo.js"),
      executableResolver,
      require.resolve("typescript"),
      require.resolve("typescript/package.json"),
    ].map(assertInput);
    super(boundary.root, { toolchainFiles, generatorInputs: GENERATOR_INPUTS, assertInput });
    this.boundary = boundary;
    this.libraryRoot = path.dirname(fs.realpathSync.native(nativeBinary));
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
    const receipt = this.boundary.assert(buildInfo);
    const info: { fileNames: string[]; fileInfos: unknown[]; packageJsons?: string[] } = JSON.parse(
      fs.readFileSync(receipt, "utf8"),
    );
    const directory = path.dirname(receipt);
    const inputs = [
      ...new Set([
        ...info.fileNames
          .slice(0, info.fileInfos.length)
          .map((file) =>
            path.resolve(
              file.startsWith("lib.") && !file.includes("/") ? this.libraryRoot : directory,
              file,
            ),
          ),
        ...(info.packageJsons ?? []).map((file) => path.resolve(directory, file)),
      ]),
    ]
      .map((file) => portableRelativePath(this.rootDir, this.boundary.resolve(file)))
      .toSorted();
    return {
      version: ARTIFACT_CACHE_VERSION,
      ...this.seal(config, args, inputs, before, startedAt, outputRoot),
      outputs: Object.fromEntries(outputs.map((file) => [file, this.hash(file)])),
    };
  }
}
