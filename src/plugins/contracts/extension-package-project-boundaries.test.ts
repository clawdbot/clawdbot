import fs from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExtensionsWithTsconfig,
  collectOptInExtensionPackageBoundaries,
  EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS,
  EXTENSION_PACKAGE_BOUNDARY_EXCLUDE,
  EXTENSION_PACKAGE_BOUNDARY_INCLUDE,
  EXTENSION_PACKAGE_BOUNDARY_XAI_PATHS,
  isOptInExtensionPackageBoundaryTsconfig,
  readExtensionPackageBoundaryPackageJson,
  readExtensionPackageBoundaryTsconfig,
} from "../../../scripts/lib/extension-package-boundary.ts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../test-utils/repo-files.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG =
  "extensions/tsconfig.package-boundary.paths.json" as const;
const EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG =
  "extensions/tsconfig.package-boundary.base.json" as const;
const trackedCodeFilesByRoot = new Map<string, readonly string[] | null>();

type TsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    paths?: unknown;
    rootDir?: unknown;
    outDir?: unknown;
    declaration?: unknown;
    emitDeclarationOnly?: unknown;
  };
  include?: unknown;
  exclude?: unknown;
};

type PackageJson = {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  type?: unknown;
  exports?: Record<string, { types?: unknown; default?: unknown }>;
  devDependencies?: Record<string, string>;
};
const MEMORY_HOST_SDK_EXPORTS = [
  "./engine",
  "./engine-embeddings",
  "./engine-foundation",
  "./engine-qmd",
  "./engine-storage",
  "./multimodal",
  "./query",
  "./runtime",
  "./runtime-cli",
  "./runtime-core",
  "./runtime-files",
  "./secret",
  "./status",
] as const;
const MEMORY_HOST_SDK_ALLOWED_CORE_BRIDGE_FILES = [
  "packages/memory-host-sdk/src/host/openclaw-runtime-auth.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-network.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime.ts",
] as const;
const MEMORY_HOST_SDK_RUNTIME_ADAPTER_FILES = [
  "packages/memory-host-sdk/src/host/openclaw-runtime-agent.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-cli.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-config.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-io.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-memory.ts",
  "packages/memory-host-sdk/src/host/openclaw-runtime-session.ts",
] as const;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe JSON file shape.
function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

function listTrackedCodeFiles(relativeDir: string): string[] | null {
  if (trackedCodeFilesByRoot.has(relativeDir)) {
    const files = trackedCodeFilesByRoot.get(relativeDir);
    return files ? [...files] : null;
  }
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeDir });
  if (!trackedFiles) {
    trackedCodeFilesByRoot.set(relativeDir, null);
    return null;
  }
  const files = trackedFiles
    .filter((line) => line.length > 0 && /\.(?:[cm]?ts|tsx|mts|cts)$/u.test(line))
    .filter((line) => fs.existsSync(resolve(REPO_ROOT, line)))
    .toSorted();
  trackedCodeFilesByRoot.set(relativeDir, files);
  return [...files];
}

function collectCodeFiles(relativeDir: string): string[] {
  const trackedFiles = listTrackedCodeFiles(relativeDir);
  if (trackedFiles) {
    return trackedFiles;
  }

  const dir = resolve(REPO_ROOT, relativeDir);
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const nextPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectCodeFiles(toRepoRelativePath(REPO_ROOT, nextPath)));
      continue;
    }
    if (entry.isFile() && /\.(?:[cm]?ts|tsx|mts|cts)$/u.test(entry.name)) {
      files.push(toRepoRelativePath(REPO_ROOT, nextPath));
    }
  }
  return files.toSorted();
}

function collectCoreReferenceFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir).filter((file) => {
    const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
    return source.includes("../../../../src/") || source.includes("../../../src/");
  });
}

function collectOpenClawRuntimeDirectImportFiles(relativeDir: string): string[] {
  return collectCodeFiles(relativeDir).filter((file) => {
    const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
    return source.includes('"./openclaw-runtime.js"');
  });
}

describe("opt-in extension package boundaries", () => {
  it("lists package boundary code files from git without walking package roots", () => {
    expectNoReaddirSyncDuring(() => {
      const memoryHostFiles = collectCodeFiles("packages/memory-host-sdk/src");
      const packageContractFiles = collectCodeFiles("packages/plugin-package-contract/src");

      expect(memoryHostFiles.length).toBeGreaterThan(0);
      expect(packageContractFiles.length).toBeGreaterThan(0);
    });
  });

  it("keeps path aliases in a dedicated shared config", () => {
    const pathsConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG);
    expect(pathsConfig.extends).toBe("../tsconfig.json");
    expect(pathsConfig.compilerOptions?.paths).toEqual(EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS);

    const baseConfig = readJsonFile<TsConfigJson>(EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG);
    expect(baseConfig.extends).toBe("./tsconfig.package-boundary.paths.json");
    expect(baseConfig.compilerOptions).toEqual({
      ignoreDeprecations: "6.0",
    });
  });

  it("keeps every opt-in extension rooted inside its package and on the package sdk", () => {
    const extensionsWithTsconfig = collectExtensionsWithTsconfig(REPO_ROOT);
    const optInExtensions = collectOptInExtensionPackageBoundaries(REPO_ROOT);

    expect(extensionsWithTsconfig).toEqual(optInExtensions);

    for (const extensionName of optInExtensions) {
      const tsconfig = readExtensionPackageBoundaryTsconfig(extensionName, REPO_ROOT);
      expect(isOptInExtensionPackageBoundaryTsconfig(tsconfig)).toBe(true);
      expect(tsconfig.compilerOptions?.rootDir).toBe(".");
      expect(tsconfig.include).toEqual([...EXTENSION_PACKAGE_BOUNDARY_INCLUDE]);
      expect(tsconfig.exclude).toEqual([...EXTENSION_PACKAGE_BOUNDARY_EXCLUDE]);

      const packageJson = readExtensionPackageBoundaryPackageJson(extensionName, REPO_ROOT);
      expect(packageJson.devDependencies?.["@openclaw/plugin-sdk"]).toBe("workspace:*");
    }
  });

  it("keeps xai as the only opt-in extension with custom path overrides", () => {
    const optInExtensions = collectOptInExtensionPackageBoundaries(REPO_ROOT);
    const extensionsWithCustomPaths = optInExtensions.filter((extensionName) => {
      const tsconfig = readExtensionPackageBoundaryTsconfig(extensionName, REPO_ROOT);
      return tsconfig.compilerOptions?.paths !== undefined;
    });

    expect(extensionsWithCustomPaths).toEqual(["xai"]);
  });

  it("keeps xai's boundary-specific path overrides derived from the shared package boundary map", () => {
    const tsconfig = readExtensionPackageBoundaryTsconfig("xai", REPO_ROOT);
    expect(tsconfig.compilerOptions?.paths).toEqual(EXTENSION_PACKAGE_BOUNDARY_XAI_PATHS);
  });

  it("keeps plugin-sdk package types generated from the package build, not a hand-maintained types bridge", () => {
    const tsconfig = readJsonFile<TsConfigJson>("packages/plugin-sdk/tsconfig.json");
    expect(tsconfig.extends).toBe("../../tsconfig.json");
    expect(tsconfig.compilerOptions?.declaration).toBe(true);
    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBe(true);
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.compilerOptions?.rootDir).toBe("../..");
    expect(tsconfig.include).toEqual([
      "../../src/plugin-sdk/**/*.ts",
      "../../src/video-generation/dashscope-compatible.ts",
      "../../src/video-generation/types.ts",
      "../../src/types/**/*.d.ts",
    ]);

    const packageJson = readJsonFile<PackageJson>("packages/plugin-sdk/package.json");
    expect(packageJson.name).toBe("@openclaw/plugin-sdk");
    expect(packageJson.exports?.["./account-id"]?.types).toBe(
      "./dist/src/plugin-sdk/account-id.d.ts",
    );
    expect(packageJson.exports?.["./acp-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/acp-runtime.d.ts",
    );
    expect(packageJson.exports?.["./channel-secret-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/channel-secret-runtime.d.ts",
    );
    expect(packageJson.exports?.["./channel-streaming"]?.types).toBe(
      "./dist/src/plugin-sdk/channel-streaming.d.ts",
    );
    expect(packageJson.exports?.["./cli-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/cli-runtime.d.ts",
    );
    expect(packageJson.exports?.["./core"]?.types).toBe("./dist/src/plugin-sdk/core.d.ts");
    expect(packageJson.exports?.["./error-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/error-runtime.d.ts",
    );
    expect(packageJson.exports?.["./plugin-entry"]?.types).toBe(
      "./dist/src/plugin-sdk/plugin-entry.d.ts",
    );
    expect(packageJson.exports?.["./plugin-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/plugin-runtime.d.ts",
    );
    expect(packageJson.exports?.["./provider-env-vars"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-env-vars.d.ts",
    );
    expect(packageJson.exports?.["./provider-http"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-http.d.ts",
    );
    expect(packageJson.exports?.["./provider-usage"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-usage.d.ts",
    );
    expect(packageJson.exports?.["./provider-web-search-contract"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-web-search-contract.d.ts",
    );
    expect(packageJson.exports?.["./provider-web-search-config-contract"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-web-search-config-contract.d.ts",
    );
    expect(packageJson.exports?.["./runtime-doctor"]?.types).toBe(
      "./dist/src/plugin-sdk/runtime-doctor.d.ts",
    );
    expect(packageJson.exports?.["./security-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/security-runtime.d.ts",
    );
    expect(packageJson.exports?.["./secret-ref-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/secret-ref-runtime.d.ts",
    );
    expect(packageJson.exports?.["./ssrf-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/ssrf-runtime.d.ts",
    );
    expect(packageJson.exports?.["./config-contracts"]?.types).toBe(
      "./dist/src/plugin-sdk/config-contracts.d.ts",
    );
    expect(packageJson.exports?.["./text-utility-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/text-utility-runtime.d.ts",
    );
    expect(packageJson.exports?.["./video-generation"]?.types).toBe(
      "./dist/src/plugin-sdk/video-generation.d.ts",
    );
    expect(packageJson.exports?.["./provider-model-types"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-model-types.d.ts",
    );
    expect(packageJson.exports?.["./channel-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/channel-runtime.d.ts",
    );
    expect(packageJson.exports?.["./compat"]?.types).toBe("./dist/src/plugin-sdk/compat.d.ts");
    expect(packageJson.exports?.["./config-types"]?.types).toBe(
      "./dist/src/plugin-sdk/config-types.d.ts",
    );
    expect(packageJson.exports?.["./infra-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/infra-runtime.d.ts",
    );
    expect(packageJson.exports?.["./text-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/text-runtime.d.ts",
    );
    expect(packageJson.exports?.["./zod"]?.types).toBe("./dist/src/plugin-sdk/zod.d.ts");
    expect(fs.existsSync(resolve(REPO_ROOT, "packages/plugin-sdk/types/plugin-entry.d.ts"))).toBe(
      false,
    );
  });

  it("keeps memory-host-sdk as a private package-owned contract surface", () => {
    const packageJson = readJsonFile<PackageJson>("packages/memory-host-sdk/package.json");
    const packageExports = packageJson.exports as unknown as Record<string, string>;

    expect(packageJson.name).toBe("@openclaw/memory-host-sdk");
    expect(packageJson.version).toBe("0.0.0-private");
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(Object.keys(packageExports).toSorted()).toEqual([...MEMORY_HOST_SDK_EXPORTS]);

    for (const exportPath of MEMORY_HOST_SDK_EXPORTS) {
      const target = packageExports[exportPath];
      expect(target, exportPath).toBe(`./src/${exportPath.slice(2)}.ts`);
      if (!target) {
        throw new Error(`Missing memory-host-sdk export target for ${exportPath}`);
      }
      const source = fs.readFileSync(
        resolve(REPO_ROOT, "packages/memory-host-sdk", target),
        "utf8",
      );
      expect(source, target).not.toContain("src/memory-host-sdk/");
    }

    expect(collectCoreReferenceFiles("packages/memory-host-sdk/src")).toEqual([
      ...MEMORY_HOST_SDK_ALLOWED_CORE_BRIDGE_FILES,
    ]);
    expect(collectOpenClawRuntimeDirectImportFiles("packages/memory-host-sdk/src")).toEqual([
      ...MEMORY_HOST_SDK_RUNTIME_ADAPTER_FILES,
    ]);
  });

  it("keeps plugin-package-contract independent from core internals", () => {
    expect(collectCoreReferenceFiles("packages/plugin-package-contract/src")).toStrictEqual([]);
  });
});
