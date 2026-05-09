import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES } from "../src/plugin-sdk/test-helpers/public-artifacts.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES = new Set(
  GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES,
);
const CHANNEL_CONTRACT_TEST_HELPERS_PREFIX = "src/channels/plugins/contracts/test-helpers/";
const BUNDLED_PLUGIN_RESOLVER_TEST_FILES = [
  "src/plugin-sdk/facade-loader.test.ts",
  "src/plugins/public-surface-loader.test.ts",
  "src/plugins/public-surface-runtime.test.ts",
] as const;
const BROAD_PUBLIC_SOURCE_ARTIFACT_BASENAMES = new Set(["api.js", "runtime-api.js"]);
const ROOTDIR_BOUNDARY_CANARY_RE =
  /(^|\/)__rootdir_boundary_canary__\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;

function walk(dir: string, entries: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      walk(fullPath, entries);
      continue;
    }
    if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      continue;
    }
    entries.push(path.relative(repoRoot, fullPath).replaceAll(path.sep, "/"));
  }
  return entries;
}

function walkCode(dir: string, entries: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      walkCode(fullPath, entries);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
      continue;
    }
    const relativePath = path.relative(repoRoot, fullPath).replaceAll(path.sep, "/");
    if (ROOTDIR_BOUNDARY_CANARY_RE.test(relativePath)) {
      continue;
    }
    entries.push(relativePath);
  }
  return entries;
}

function findExtensionImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']((?:\.\.\/)+extensions\/[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["']((?:\.\.\/)+extensions\/[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function isAllowedExtensionPublicImport(specifier: string): boolean {
  return /(?:^|\/)extensions\/[^/]+\/(?:api|index|runtime-api|setup-entry|login-qr-api)\.js$/u.test(
    specifier,
  );
}

function findPluginSdkImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["']((?:\.\.\/)+plugin-sdk\/[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function findBundledPluginPublicSurfaceImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["'](?:\.\.\/)+test-utils\/bundled-plugin-public-surface\.js["']/g),
    ...source.matchAll(
      /import\(\s*["'](?:\.\.\/)+test-utils\/bundled-plugin-public-surface\.js["']\s*\)/g,
    ),
  ].map((match) => match[0]);
}

function findRelativeSrcImports(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']((?:\.\.?\/)+src\/[^"']+)["']/g),
    ...source.matchAll(/import\(\s*["']((?:\.\.?\/)+src\/[^"']+)["']\s*\)/g),
    ...source.matchAll(/vi\.(?:mock|doMock)\s*\(\s*["']((?:\.\.?\/)+src\/[^"']+)["']/g),
  ].map((match) => match[1]);
}

function getImportBasename(importPath: string): string {
  return importPath.split("/").at(-1) ?? importPath;
}

function collectBundledPluginIds(): Set<string> {
  return new Set(
    fs
      .readdirSync(path.join(repoRoot, "extensions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function getLineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function findRealBroadSourceApiResolverReferences(
  source: string,
  pluginIds: Set<string>,
): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/\{[^{}]*\bdirName:\s*["'][^"']+["'][^{}]*\}/g)) {
    const objectLiteral = match[0];
    const dirName = objectLiteral.match(/\bdirName:\s*["']([^"']+)["']/)?.[1];
    const artifactBasename = objectLiteral.match(/\bartifactBasename:\s*["']([^"']+)["']/)?.[1];
    if (
      dirName &&
      artifactBasename &&
      pluginIds.has(dirName) &&
      BROAD_PUBLIC_SOURCE_ARTIFACT_BASENAMES.has(artifactBasename)
    ) {
      offenders.push(`${dirName}/${artifactBasename}:${getLineNumber(source, match.index ?? 0)}`);
    }
  }

  return offenders;
}

function isAllowedCoreContractSuite(file: string, imports: readonly string[]): boolean {
  return (
    file.startsWith("src/channels/plugins/contracts/") &&
    file.endsWith(".contract.test.ts") &&
    imports.every((entry) =>
      ALLOWED_EXTENSION_PUBLIC_SURFACE_BASENAMES.has(getImportBasename(entry)),
    )
  );
}

describe("non-extension test boundaries", () => {
  it("keeps plugin-owned behavior suites under the bundled plugin tree", () => {
    const testFiles = [
      ...walk(path.join(repoRoot, "src")),
      ...walk(path.join(repoRoot, "test")),
      ...walk(path.join(repoRoot, "packages")),
    ].filter(
      (file) =>
        !file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
        !file.startsWith("test/helpers/") &&
        !file.startsWith("ui/"),
    );

    const offenders = testFiles
      .map((file) => {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const imports = findExtensionImports(source).filter(
          (specifier) => !isAllowedExtensionPublicImport(specifier),
        );
        if (imports.length === 0) {
          return null;
        }
        if (isAllowedCoreContractSuite(file, imports)) {
          return null;
        }
        return {
          file,
          imports,
        };
      })
      .filter((value): value is { file: string; imports: string[] } => value !== null);

    expect(offenders).toStrictEqual([]);
  });

  it("keeps extension-owned onboard helper coverage out of the core onboard auth suite", () => {
    const bannedPluginSdkModules = new Set<string>([
      "../plugin-sdk/litellm.js",
      "../plugin-sdk/minimax.js",
      "../plugin-sdk/mistral.js",
      "../plugin-sdk/opencode-go.js",
      "../plugin-sdk/opencode.js",
      "../plugin-sdk/openrouter.js",
      "../plugin-sdk/synthetic.js",
      "../plugin-sdk/xai.js",
      "../plugin-sdk/xiaomi.js",
    ]);
    const file = "src/commands/onboard-auth.test.ts";
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const imports = findPluginSdkImports(source).filter((entry) =>
      bannedPluginSdkModules.has(entry),
    );

    expect(imports).toStrictEqual([]);
  });

  it("keeps bundled plugin public-surface imports out of core source", () => {
    const files = walkCode(path.join(repoRoot, "src")).filter(
      (file) => !file.startsWith(CHANNEL_CONTRACT_TEST_HELPERS_PREFIX),
    );

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return findBundledPluginPublicSurfaceImports(source).length > 0;
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled plugin sync test-api loaders out of core tests", () => {
    const files = [
      ...walkCode(path.join(repoRoot, "src")),
      ...walkCode(path.join(repoRoot, "test")),
    ]
      .filter((file) => !file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX))
      .filter((file) => !file.startsWith(CHANNEL_CONTRACT_TEST_HELPERS_PREFIX))
      .filter((file) => !file.startsWith("test/helpers/"))
      .filter((file) => file !== "test/extension-test-boundary.test.ts");

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return source.includes("loadBundledPluginTestApiSync(");
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps resolver tests on generated fixtures for broad bundled plugin source APIs", () => {
    const bundledPluginIds = collectBundledPluginIds();
    const offenders = BUNDLED_PLUGIN_RESOLVER_TEST_FILES.flatMap((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return findRealBroadSourceApiResolverReferences(source, bundledPluginIds).map(
        (reference) => `${file}: ${reference}`,
      );
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled channel security collector coverage under extension tests", () => {
    const files = [...walk(path.join(repoRoot, "src")), ...walk(path.join(repoRoot, "test"))]
      .filter((file) => !file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX))
      .filter((file) => !file.startsWith("test/helpers/"))
      .filter((file) => file !== "test/extension-test-boundary.test.ts");

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return (
        source.includes("test/helpers/channels/security-audit-contract.js") ||
        source.includes("src/channels/plugins/contracts/test-helpers/security-audit-contract.js")
      );
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps extension channel contract helpers on the public testing surface", () => {
    const files = walkCode(path.join(repoRoot, "extensions"));

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return source.includes("src/channels/plugins/contracts/test-helpers/");
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps extension tests off legacy broad testing barrels and repo helper bridges", () => {
    const bannedPatterns = [
      /["']openclaw\/plugin-sdk\/testing["']/u,
      /["']openclaw\/plugin-sdk\/test-utils["']/u,
      /["'](?:\.\.\/)+(?:test\/helpers\/channels\/)[^"']+["']/u,
      /["'](?:\.\.\/)+(?:src\/channels\/plugins\/contracts\/test-helpers\/)[^"']+["']/u,
      /["'](?:\.\.\/)+(?:test\/helpers\/plugins\/)[^"']+["']/u,
      /["'](?:\.\.\/)+(?:test\/helpers\/)[^"']+["']/u,
    ];
    const files = walkCode(path.join(repoRoot, "extensions"));

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return bannedPatterns.some((pattern) => pattern.test(source));
    });

    expect(offenders).toStrictEqual([]);
  });

  it("keeps extension root test-support helpers from reaching into private src trees", () => {
    const files = walkCode(path.join(repoRoot, "extensions")).filter((file) =>
      /^extensions\/[^/]+\/test-support(?:\.ts|\/)/u.test(file),
    );

    const offenders = files
      .map((file) => {
        const imports = findRelativeSrcImports(fs.readFileSync(path.join(repoRoot, file), "utf8"));
        return imports.length === 0 ? null : { file, imports };
      })
      .filter((entry): entry is { file: string; imports: string[] } => entry !== null);

    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled extension sources off deprecated channel config schema aliases", () => {
    const files = walkCode(path.join(repoRoot, "extensions"));

    const offenders = files.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return source.includes("openclaw/plugin-sdk/channel-config-schema-legacy");
    });

    expect(offenders).toStrictEqual([]);
  });
});
