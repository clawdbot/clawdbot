import { existsSync, readFileSync } from "node:fs";
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

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const EXTENSION_PACKAGE_BOUNDARY_PATHS_CONFIG =
  "extensions/tsconfig.package-boundary.paths.json" as const;
const EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG =
  "extensions/tsconfig.package-boundary.base.json" as const;

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
  exports?: Record<string, { types?: unknown; default?: unknown }>;
  devDependencies?: Record<string, string>;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe JSON file shape.
function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

describe("opt-in extension package boundaries", () => {
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
    expect(packageJson.exports?.["./browser-config-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/browser-config-runtime.d.ts",
    );
    expect(packageJson.exports?.["./browser-node-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/browser-node-runtime.d.ts",
    );
    expect(packageJson.exports?.["./browser-setup-tools"]?.types).toBe(
      "./dist/src/plugin-sdk/browser-setup-tools.d.ts",
    );
    expect(packageJson.exports?.["./browser-security-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/browser-security-runtime.d.ts",
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
    expect(packageJson.exports?.["./text-runtime"]?.types).toBe(
      "./dist/src/plugin-sdk/text-runtime.d.ts",
    );
    expect(packageJson.exports?.["./video-generation"]?.types).toBe(
      "./dist/src/plugin-sdk/video-generation.d.ts",
    );
    expect(packageJson.exports?.["./provider-model-types"]?.types).toBe(
      "./dist/src/plugin-sdk/provider-model-types.d.ts",
    );
    expect(packageJson.exports?.["./zod"]?.types).toBe("./dist/src/plugin-sdk/zod.d.ts");
    expect(existsSync(resolve(REPO_ROOT, "packages/plugin-sdk/types/plugin-entry.d.ts"))).toBe(
      false,
    );
  });
});
