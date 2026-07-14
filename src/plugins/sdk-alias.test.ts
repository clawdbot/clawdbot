// Verifies plugin SDK alias resolution for public import paths.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  buildPluginLoaderAliasMap,
  createPluginLoaderModuleCacheKey,
  buildPluginLoaderJitiOptions,
  resolvePluginLoaderModuleConfig,
  resolvePluginLoaderTryNative,
  resolvePluginRuntimeModulePathWithDiagnostics,
  shouldPreferNativeModuleLoad,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

type CreateJiti = typeof import("jiti").createJiti;

let createJitiPromise: Promise<CreateJiti> | undefined;

async function getCreateJiti() {
  createJitiPromise ??= import("jiti").then(({ createJiti }) => createJiti);
  return createJitiPromise;
}

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-sdk-alias-root", fixtureTempDirs);
let tempDirIndex = 0;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  mkdirSafeDir(dir);
  return dir;
}

function createTrustedOpenClawPackageFixture(version: string) {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "openclaw",
        version,
        bin: { openclaw: "openclaw.mjs" },
        exports: { "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" } },
      },
      null,
      2,
    ),
    "utf-8",
  );
  mkdirSafeDir(path.join(root, "dist", "plugins"));
  return root;
}

function withCwd<T>(cwd: string, run: () => T): T {
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  try {
    return run();
  } finally {
    cwdSpy.mockRestore();
  }
}

function createPluginSdkAliasFixture(params?: {
  srcFile?: string;
  distFile?: string;
  srcBody?: string;
  distBody?: string;
  packageExports?: Record<string, unknown>;
  trustedRootIndicators?: boolean;
  trustedRootIndicatorMode?: "bin+marker" | "cli-entry-only" | "none";
}) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugin-sdk", params?.srcFile ?? "index.ts");
  const distFile = path.join(root, "dist", "plugin-sdk", params?.distFile ?? "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  const trustedRootIndicatorMode =
    params?.trustedRootIndicatorMode ??
    (params?.trustedRootIndicators === false ? "none" : "bin+marker");
  const packageJson: Record<string, unknown> = {
    name: "openclaw",
    type: "module",
  };
  if (trustedRootIndicatorMode === "bin+marker") {
    packageJson.bin = {
      openclaw: "openclaw.mjs",
    };
  }
  if (params?.packageExports || trustedRootIndicatorMode === "cli-entry-only") {
    const trustedExports: Record<string, unknown> =
      trustedRootIndicatorMode === "cli-entry-only"
        ? { "./cli-entry": { default: "./dist/cli-entry.js" } }
        : {};
    packageJson.exports = {
      "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
      ...trustedExports,
      ...params?.packageExports,
    };
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
  if (trustedRootIndicatorMode === "bin+marker") {
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
  }
  mkdirSafeDir(path.join(root, "scripts", "lib"));
  fs.writeFileSync(
    path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
    JSON.stringify(["qa-channel", "qa-channel-protocol", "qa-lab", "qa-runtime"], null, 2),
    "utf-8",
  );
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

function writePluginSdkSubpathArtifacts(root: string, subpaths: readonly string[]) {
  for (const subpath of subpaths) {
    for (const candidate of [
      path.join(root, "src", "plugin-sdk", `${subpath}.ts`),
      path.join(root, "dist", "plugin-sdk", `${subpath}.js`),
    ]) {
      if (!fs.existsSync(candidate)) {
        fs.writeFileSync(candidate, "export {};\n", "utf-8");
      }
    }
  }
}

function createExtensionApiAliasFixture(params?: {
  srcBody?: string;
  distBody?: string;
  srcExtension?: ".ts" | ".mts" | ".js" | ".mjs" | ".cts" | ".cjs";
}) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", `extensionAPI${params?.srcExtension ?? ".ts"}`);
  const distFile = path.join(root, "dist", "extensionAPI.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf-8");
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf-8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf-8");
  return { root, srcFile, distFile };
}

function writeWorkspacePackageEntry(params: {
  root: string;
  packageDir: string;
  srcFile: string;
  distFile: string;
}) {
  const srcFile = path.join(params.root, "packages", params.packageDir, "src", params.srcFile);
  const distFile = path.join(params.root, "packages", params.packageDir, "dist", params.distFile);
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(srcFile, "export {};\n", "utf-8");
  fs.writeFileSync(distFile, "export {};\n", "utf-8");
  return { srcFile, distFile };
}

function createPluginRuntimeAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugins", "runtime", "index.ts");
  const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    srcFile,
    params?.srcBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  fs.writeFileSync(
    distFile,
    params?.distBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf-8",
  );
  return { root, srcFile, distFile };
}

function createPluginSdkAliasTargetFixture(params?: {
  sourceChannelRuntimeExtension?: ".ts" | ".mts" | ".js" | ".mjs" | ".cts" | ".cjs";
}) {
  const sourceChannelRuntimeExtension = params?.sourceChannelRuntimeExtension ?? ".ts";
  const fixture = createPluginSdkAliasFixture({
    srcFile: `channel-runtime${sourceChannelRuntimeExtension}`,
    distFile: "channel-runtime.js",
    packageExports: {
      "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
      "./plugin-sdk/plugin-entry": { default: "./dist/plugin-sdk/plugin-entry.js" },
    },
  });
  const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
  const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
  const sourcePluginEntryPath = path.join(fixture.root, "src", "plugin-sdk", "plugin-entry.ts");
  const distPluginEntryPath = path.join(fixture.root, "dist", "plugin-sdk", "plugin-entry.js");
  fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
  fs.writeFileSync(distRootAlias, "module.exports = {};\n", "utf-8");
  fs.writeFileSync(
    sourcePluginEntryPath,
    "export const definePluginEntry = (entry) => entry;\n",
    "utf-8",
  );
  fs.writeFileSync(
    distPluginEntryPath,
    "export const definePluginEntry = (entry) => entry;\n",
    "utf-8",
  );
  return {
    fixture,
    sourceRootAlias,
    distRootAlias,
    sourceChannelRuntimePath: path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      `channel-runtime${sourceChannelRuntimeExtension}`,
    ),
    distChannelRuntimePath: path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js"),
    sourcePluginEntryPath,
    distPluginEntryPath,
  };
}

function createBundledPluginPackagePublicSurfaceAliasFixture() {
  const fixture = createPluginSdkAliasTargetFixture();
  const extensionRoot = path.join(fixture.fixture.root, bundledPluginRoot("slack"));
  const distExtensionRoot = path.join(fixture.fixture.root, "dist", "extensions", "slack");
  mkdirSafeDir(extensionRoot);
  mkdirSafeDir(distExtensionRoot);
  fs.writeFileSync(
    path.join(extensionRoot, "package.json"),
    JSON.stringify({ name: "@openclaw/slack", type: "module" }, null, 2),
    "utf-8",
  );
  const sourceApiPath = path.join(extensionRoot, "api.ts");
  const sourceRuntimeApiPath = path.join(extensionRoot, "runtime-api.ts");
  const sourceTestApiPath = path.join(extensionRoot, "test-api.ts");
  const distApiPath = path.join(distExtensionRoot, "api.js");
  const distRuntimeApiPath = path.join(distExtensionRoot, "runtime-api.js");
  const distTestApiPath = path.join(distExtensionRoot, "test-api.js");
  fs.writeFileSync(sourceApiPath, "export const slackApi = 'source';\n", "utf-8");
  fs.writeFileSync(sourceRuntimeApiPath, "export const slackRuntimeApi = 'source';\n", "utf-8");
  fs.writeFileSync(sourceTestApiPath, "export const slackTestApi = 'source';\n", "utf-8");
  fs.writeFileSync(distApiPath, "export const slackApi = 'dist';\n", "utf-8");
  fs.writeFileSync(distRuntimeApiPath, "export const slackRuntimeApi = 'dist';\n", "utf-8");
  fs.writeFileSync(distTestApiPath, "export const slackTestApi = 'dist';\n", "utf-8");
  fs.writeFileSync(
    path.join(extensionRoot, "internal.ts"),
    "export const internal = true;\n",
    "utf-8",
  );
  return {
    ...fixture,
    distApiPath,
    distRuntimeApiPath,
    distTestApiPath,
    sourceApiPath,
    sourceRuntimeApiPath,
    sourceTestApiPath,
  };
}

function writePluginEntry(root: string, relativePath: string) {
  const pluginEntry = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(pluginEntry), { recursive: true });
  fs.writeFileSync(pluginEntry, 'export const plugin = "demo";\n', "utf-8");
  return pluginEntry;
}

function writeInstalledPluginEntry(params: {
  installRoot: string;
  packageName: string;
  entry?: string;
}) {
  const entry = params.entry ?? "dist/index.js";
  const packageRoot = path.join(
    params.installRoot,
    "node_modules",
    ...params.packageName.split("/"),
  );
  const pluginEntry = path.join(packageRoot, entry);
  mkdirSafeDir(path.dirname(pluginEntry));
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: params.packageName, type: "module" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(pluginEntry, 'export const plugin = "installed";\n', "utf-8");
  return { packageRoot, pluginEntry };
}

function createUserInstalledPluginSdkAliasFixture() {
  const { fixture, sourcePluginEntryPath, sourceRootAlias, sourceChannelRuntimePath } =
    createPluginSdkAliasTargetFixture();
  const externalPluginRoot = path.join(makeTempDir(), ".openclaw", "extensions", "demo");
  const externalPluginEntry = path.join(externalPluginRoot, "index.ts");
  mkdirSafeDir(externalPluginRoot);
  fs.writeFileSync(
    externalPluginEntry,
    [
      'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";',
      'export default definePluginEntry({ id: "demo", register() {} });',
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    externalPluginEntry,
    externalPluginRoot,
    fixture,
    sourcePluginEntryPath,
    sourceRootAlias,
    sourceChannelRuntimePath,
  };
}

function resolvePluginRuntimeModule(params: {
  modulePath: string;
  argv1?: string;
  devSourceRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const run = () =>
    resolvePluginRuntimeModulePathWithDiagnostics({
      modulePath: params.modulePath,
      argv1: params.argv1,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    }).resolvedPath;
  return params.env ? withEnv(params.env, run) : run();
}

function expectResolvedFixturePath(params: {
  resolved: string | null;
  fixture: { srcFile: string; distFile: string };
  expected: "src" | "dist";
}) {
  expect(params.resolved).toBe(
    params.expected === "dist" ? params.fixture.distFile : params.fixture.srcFile,
  );
}

function expectPluginSdkAliasTargets(
  aliases: Record<string, string | undefined>,
  params: {
    rootAliasPath: string;
    channelRuntimePath?: string;
    pluginEntryPath?: string;
  },
) {
  expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
    fs.realpathSync(params.rootAliasPath),
  );
  expect(fs.realpathSync(aliases["@openclaw/plugin-sdk"] ?? "")).toBe(
    fs.realpathSync(params.rootAliasPath),
  );
  if (params.channelRuntimePath) {
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(params.channelRuntimePath),
    );
    expect(fs.realpathSync(aliases["@openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(params.channelRuntimePath),
    );
  }
  if (params.pluginEntryPath) {
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/plugin-entry"] ?? "")).toBe(
      fs.realpathSync(params.pluginEntryPath),
    );
    expect(fs.realpathSync(aliases["@openclaw/plugin-sdk/plugin-entry"] ?? "")).toBe(
      fs.realpathSync(params.pluginEntryPath),
    );
  }
}

function expectExtensionApiAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  modulePath: (root: string) => string;
  argv1?: (root: string) => string;
  env?: NodeJS.ProcessEnv;
  expected: "src" | "dist";
}) {
  const resolved = withEnv(
    params.env ?? {},
    () =>
      buildPluginLoaderAliasMap(
        params.modulePath(params.fixture.root),
        params.argv1?.(params.fixture.root) ?? "",
      )["openclaw/extension-api"] ?? null,
  );
  expectResolvedFixturePath({
    resolved,
    fixture: params.fixture,
    expected: params.expected,
  });
}

function listPluginSdkExportedSubpaths(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string[] {
  return Object.keys(
    buildPluginLoaderAliasMap(
      params.modulePath,
      params.argv1 ?? "",
      params.moduleUrl,
      params.pluginSdkResolution,
      params.devSourceRoot,
    ),
  )
    .filter((key) => key.startsWith("openclaw/plugin-sdk/"))
    .map((key) => key.slice("openclaw/plugin-sdk/".length))
    .toSorted();
}

function expectExportedSubpaths(params: {
  fixture: { root: string };
  modulePath: string;
  expected: readonly string[];
  cwd?: string;
}) {
  const run = () => listPluginSdkExportedSubpaths({ modulePath: params.modulePath });
  const subpaths = params.cwd ? withCwd(params.cwd, run) : run();
  expect(subpaths).toEqual(params.expected);
}

function expectCwdFallbackPluginSdkAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  expected: "src" | "dist" | null;
}) {
  const resolved = withCwd(params.fixture.root, () =>
    withEnv(
      { NODE_ENV: undefined },
      () =>
        buildPluginLoaderAliasMap("/tmp/tsx-cache/openclaw-loader.js", "")[
          "openclaw/plugin-sdk/channel-runtime"
        ] ?? null,
    ),
  );
  if (params.expected === null) {
    expect(resolved).toBeNull();
    return;
  }
  expectResolvedFixturePath({
    resolved,
    fixture: params.fixture,
    expected: params.expected,
  });
}

afterAll(() => {
  cleanupTrackedTempDirs(fixtureTempDirs);
});

describe("plugin sdk alias helpers", () => {
  it.each([
    {
      name: "prefers dist plugin-sdk alias when loader runs from dist",
      buildFixture: () => createPluginSdkAliasFixture(),
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      srcFile: "index.ts",
      distFile: "index.js",
      expected: "dist" as const,
    },
    {
      name: "prefers src plugin-sdk alias when loader runs from src in non-production",
      buildFixture: () => createPluginSdkAliasFixture(),
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
    {
      name: "falls back to src plugin-sdk alias when dist is missing in production",
      buildFixture: () => {
        const fixture = createPluginSdkAliasFixture();
        fs.rmSync(fixture.distFile);
        return fixture;
      },
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: "production", VITEST: undefined },
      expected: "src" as const,
    },
    {
      name: "prefers dist root-alias shim when loader runs from dist",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "root-alias.cjs",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          distBody: "module.exports = {};\n",
        }),
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      expected: "dist" as const,
    },
    {
      name: "prefers src root-alias shim when loader runs from src in non-production",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "root-alias.cjs",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          distBody: "module.exports = {};\n",
        }),
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
    {
      name: "resolves plugin-sdk alias from package root when loader runs from transpiler cache path",
      buildFixture: () =>
        createPluginSdkAliasFixture({
          packageExports: {
            "./plugin-sdk/index": { default: "./dist/plugin-sdk/index.js" },
          },
        }),
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      srcFile: "index.ts",
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ buildFixture, modulePath, argv1, srcFile, distFile, env, expected }) => {
    const fixture = buildFixture();
    const sourceCandidate = path.join(fixture.root, "src", "plugin-sdk", srcFile);
    const distCandidate = path.join(fixture.root, "dist", "plugin-sdk", distFile);
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    if (fs.existsSync(sourceCandidate) && sourceCandidate !== sourceRootAlias) {
      fs.copyFileSync(sourceCandidate, sourceRootAlias);
    }
    if (fs.existsSync(distCandidate) && distCandidate !== distRootAlias) {
      fs.copyFileSync(distCandidate, distRootAlias);
    }
    const resolved = withEnv(
      env ?? {},
      () =>
        buildPluginLoaderAliasMap(modulePath(fixture.root), argv1?.(fixture.root) ?? "")[
          "openclaw/plugin-sdk"
        ] ?? null,
    );
    expect(resolved).toBe(expected === "dist" ? distRootAlias : sourceRootAlias);
  });

  it.each([
    {
      name: "prefers dist extension-api alias when loader runs from dist",
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      expected: "dist" as const,
    },
    {
      name: "prefers src extension-api alias when loader runs from src in non-production",
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ modulePath, env, expected }) => {
    const fixture = createExtensionApiAliasFixture();
    expectExtensionApiAliasResolution({
      fixture,
      modulePath,
      env,
      expected,
    });
  });

  it("resolves source extension-api aliases through the wider source extension family", () => {
    const fixture = createExtensionApiAliasFixture({ srcExtension: ".mts" });
    expectExtensionApiAliasResolution({
      fixture,
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      env: { NODE_ENV: undefined },
      expected: "src",
    });
  });

  it("resolves extension-api aliases from an explicit dev source root", () => {
    const stableFixture = createExtensionApiAliasFixture({
      distBody: "export const stableExtensionApi = true;\n",
    });
    const devFixture = createExtensionApiAliasFixture({
      distBody: "export const devExtensionApi = true;\n",
    });
    mkdirSafeDir(path.join(devFixture.root, "extensions"));
    const entry = path.join(stableFixture.root, "dist", "plugins", "loader.js");
    mkdirSafeDir(path.dirname(entry));
    fs.writeFileSync(entry, "export {};\n", "utf-8");

    const aliases = buildPluginLoaderAliasMap(entry, undefined, undefined, "dist", devFixture.root);

    expect(fs.realpathSync(aliases["openclaw/extension-api"] ?? "")).toBe(
      fs.realpathSync(devFixture.distFile),
    );
  });

  it.each([
    {
      name: "prefers dist candidates first for production src runtime",
      env: { NODE_ENV: "production", VITEST: undefined },
      expectedFirst: "dist" as const,
    },
    {
      name: "prefers src candidates first for non-production src runtime",
      env: { NODE_ENV: undefined },
      expectedFirst: "src" as const,
    },
  ])("$name", ({ env, expectedFirst }) => {
    const fixture = createPluginSdkAliasFixture();
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    fs.copyFileSync(fixture.srcFile, sourceRootAlias);
    fs.copyFileSync(fixture.distFile, distRootAlias);
    const resolved = withEnv(
      env ?? {},
      () =>
        buildPluginLoaderAliasMap(path.join(fixture.root, "src", "plugins", "loader.ts"), "")[
          "openclaw/plugin-sdk"
        ],
    );
    expect(resolved).toBe(expectedFirst === "dist" ? distRootAlias : sourceRootAlias);
  });

  it("derives plugin-sdk subpaths from package exports", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/compat": { default: "./dist/plugin-sdk/compat.js" },
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/nested/value": { default: "./dist/plugin-sdk/nested/value.js" },
        "./plugin-sdk/..\\..\\evil": { default: "./dist/plugin-sdk/evil.js" },
        "./plugin-sdk/C:temp": { default: "./dist/plugin-sdk/drive.js" },
        "./plugin-sdk/.hidden": { default: "./dist/plugin-sdk/hidden.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["compat", "core"]);
    const subpaths = listPluginSdkExportedSubpaths({
      modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
    });
    expect(subpaths).toEqual(["compat", "core"]);
  });

  it("adds private qa plugin-sdk subpaths for trusted local checkouts when enabled", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["core"]);
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-channel.ts"),
      "export const qaChannel = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-channel-protocol.ts"),
      "export const qaChannelProtocol = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts"),
      "export const qaRuntime = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "dist", "plugin-sdk", "qa-lab.js"),
      "export const qaLab = true;\n",
      "utf-8",
    );

    const subpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(subpaths).toEqual(["core", "qa-channel", "qa-channel-protocol", "qa-lab", "qa-runtime"]);
  });

  it("resolves public QA plugin-sdk aliases without enabling private QA mode", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/qa-live-transport-scenarios": {
          default: "./dist/plugin-sdk/qa-live-transport-scenarios.js",
        },
        "./plugin-sdk/qa-runner-runtime": { default: "./dist/plugin-sdk/qa-runner-runtime.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["core"]);
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const sourceQaRunnerPath = path.join(fixture.root, "src", "plugin-sdk", "qa-runner-runtime.ts");
    const distQaLiveTransportScenariosPath = path.join(
      fixture.root,
      "dist",
      "plugin-sdk",
      "qa-live-transport-scenarios.js",
    );
    const sourcePrivateQaRuntimePath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "qa-runtime.ts",
    );
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(sourceQaRunnerPath, "export const qaRunnerRuntime = true;\n", "utf-8");
    fs.writeFileSync(
      distQaLiveTransportScenariosPath,
      "export const qaLiveTransportScenarios = true;\n",
      "utf-8",
    );
    fs.writeFileSync(sourcePrivateQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const subpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      listPluginSdkExportedSubpaths({ modulePath: sourcePluginEntry }),
    );
    const aliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourcePluginEntry),
    );

    expect(subpaths).toEqual(["core", "qa-live-transport-scenarios", "qa-runner-runtime"]);
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-runner-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceQaRunnerPath),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-live-transport-scenarios"] ?? "")).toBe(
      fs.realpathSync(distQaLiveTransportScenariosPath),
    );
    expect(aliases["openclaw/plugin-sdk/qa-runtime"]).toBeUndefined();
  });

  it("adds non-QA private Codex helper subpaths only for trusted Codex plugins", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["core"]);
    fs.rmSync(
      path.join(fixture.root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      { force: true },
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "codex-mcp-projection.ts"),
      "export const codexMcpProjection = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "codex-native-task-runtime.ts"),
      "export const codexNativeTaskRuntime = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts"),
      "export const qaRuntime = true;\n",
      "utf-8",
    );
    const sourceCodexEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("codex", "src/index.ts"),
    );
    const sourceOtherEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );
    const { packageRoot: installedCodexRoot, pluginEntry: installedCodexEntry } =
      writeInstalledPluginEntry({
        installRoot: path.join(makeTempDir(), ".openclaw", "npm"),
        packageName: "@openclaw/codex",
      });
    const { packageRoot: installedOtherRoot, pluginEntry: installedOtherEntry } =
      writeInstalledPluginEntry({
        installRoot: path.join(makeTempDir(), ".openclaw", "npm"),
        packageName: "@openclaw/demo",
      });
    const shadowCodexRoot = path.join(makeTempDir(), ".openclaw", "extensions", "codex-shadow");
    const shadowCodexEntry = path.join(shadowCodexRoot, "dist", "index.js");
    mkdirSafeDir(path.dirname(shadowCodexEntry));
    fs.writeFileSync(
      path.join(shadowCodexRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", type: "module" }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(shadowCodexEntry, 'export const plugin = "shadow";\n', "utf-8");

    const codexSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: sourceCodexEntry,
      }),
    );
    const otherSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: sourceOtherEntry,
      }),
    );
    const installedCodexSubpaths = withCwd(installedCodexRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
        listPluginSdkExportedSubpaths({
          modulePath: installedCodexEntry,
          argv1: path.join(fixture.root, "openclaw.mjs"),
        }),
      ),
    );
    const installedOtherSubpaths = withCwd(installedOtherRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
        listPluginSdkExportedSubpaths({
          modulePath: installedOtherEntry,
          argv1: path.join(fixture.root, "openclaw.mjs"),
        }),
      ),
    );
    const shadowCodexSubpaths = withCwd(shadowCodexRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
        listPluginSdkExportedSubpaths({
          modulePath: shadowCodexEntry,
          argv1: path.join(fixture.root, "openclaw.mjs"),
        }),
      ),
    );

    expect(codexSubpaths).toEqual(["codex-mcp-projection", "codex-native-task-runtime", "core"]);
    expect(installedCodexSubpaths).toEqual([
      "codex-mcp-projection",
      "codex-native-task-runtime",
      "core",
    ]);
    expect(otherSubpaths).toEqual(["core"]);
    expect(installedOtherSubpaths).toEqual(["core"]);
    expect(shadowCodexSubpaths).toEqual(["core"]);
  });

  it("does not reuse a non-private cached subpath list after private qa gets enabled", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["core"]);
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-channel.ts"),
      "export const qaChannel = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-channel-protocol.ts"),
      "export const qaChannelProtocol = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts"),
      "export const qaRuntime = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixture.root, "dist", "plugin-sdk", "qa-lab.js"),
      "export const qaLab = true;\n",
      "utf-8",
    );

    expect(
      listPluginSdkExportedSubpaths({
        modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
      }),
    ).toEqual(["core"]);

    const privateSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
      }),
    );
    expect(privateSubpaths).toEqual([
      "core",
      "qa-channel",
      "qa-channel-protocol",
      "qa-lab",
      "qa-runtime",
    ]);
  });

  it.each([
    {
      name: "does not derive plugin-sdk subpaths from cwd fallback when package root is not an OpenClaw root",
      fixture: () =>
        createPluginSdkAliasFixture({
          trustedRootIndicators: false,
          packageExports: {
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: [],
    },
    {
      name: "derives plugin-sdk subpaths via cwd fallback when trusted root indicator is cli-entry export",
      fixture: () =>
        createPluginSdkAliasFixture({
          trustedRootIndicatorMode: "cli-entry-only",
          packageExports: {
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: ["channel-runtime", "core"],
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    writePluginSdkSubpathArtifacts(fixture.root, ["channel-runtime", "core"]);
    expectExportedSubpaths({
      fixture,
      cwd: fixture.root,
      modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      expected,
    });
  });

  it("builds plugin-sdk aliases from the module being loaded, not the loader location", () => {
    const {
      fixture,
      sourceRootAlias,
      distRootAlias,
      sourceChannelRuntimePath,
      distChannelRuntimePath,
    } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const sourceAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );
    expectPluginSdkAliasTargets(sourceAliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: sourceChannelRuntimePath,
    });

    const distPluginEntry = writePluginEntry(
      fixture.root,
      bundledDistPluginFile("demo", "index.js"),
    );

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(distPluginEntry),
    );
    expectPluginSdkAliasTargets(distAliases, {
      rootAliasPath: distRootAlias,
      channelRuntimePath: distChannelRuntimePath,
    });
  });

  it("adds private qa plugin-sdk aliases for source plugins when enabled", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const sourceQaChannelPath = path.join(fixture.root, "src", "plugin-sdk", "qa-channel.ts");
    const sourceQaChannelProtocolPath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "qa-channel-protocol.ts",
    );
    const sourceQaRuntimePath = path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts");
    const distQaLabPath = path.join(fixture.root, "dist", "plugin-sdk", "qa-lab.js");
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(sourceQaChannelPath, "export const qaChannel = true;\n", "utf-8");
    fs.writeFileSync(
      sourceQaChannelProtocolPath,
      "export const qaChannelProtocol = true;\n",
      "utf-8",
    );
    fs.writeFileSync(sourceQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    fs.writeFileSync(distQaLabPath, "export const qaLab = true;\n", "utf-8");
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("qa-matrix", "src/index.ts"),
    );

    const aliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1", NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );

    expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceQaRuntimePath),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-channel"] ?? "")).toBe(
      fs.realpathSync(sourceQaChannelPath),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-channel-protocol"] ?? "")).toBe(
      fs.realpathSync(sourceQaChannelProtocolPath),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/qa-lab"] ?? "")).toBe(
      fs.realpathSync(distQaLabPath),
    );
  });

  it("aliases non-QA private plugin-sdk subpaths for trusted Codex runtime loading", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const sourceCodexMcpProjectionPath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "codex-mcp-projection.ts",
    );
    const sourceCodexNativeTaskRuntimePath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "codex-native-task-runtime.ts",
    );
    const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    const distCodexMcpProjectionPath = path.join(
      fixture.root,
      "dist",
      "plugin-sdk",
      "codex-mcp-projection.js",
    );
    const distCodexNativeTaskRuntimePath = path.join(
      fixture.root,
      "dist",
      "plugin-sdk",
      "codex-native-task-runtime.js",
    );
    const sourceQaRuntimePath = path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts");
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(distRootAlias, "module.exports = {};\n", "utf-8");
    fs.rmSync(
      path.join(fixture.root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      { force: true },
    );
    fs.writeFileSync(
      sourceCodexMcpProjectionPath,
      "export const codexMcpProjection = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      sourceCodexNativeTaskRuntimePath,
      "export const codexNativeTaskRuntime = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      distCodexMcpProjectionPath,
      "export const codexMcpProjection = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      distCodexNativeTaskRuntimePath,
      "export const codexNativeTaskRuntime = true;\n",
      "utf-8",
    );
    fs.writeFileSync(sourceQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("codex", "src/index.ts"),
    );
    const distCodexEntry = writePluginEntry(
      fixture.root,
      path.join("dist", "extensions", "codex", "index.js"),
    );
    const sourceOtherPluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );
    const devFixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    const devRootAlias = path.join(devFixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    const devCodexMcpProjectionPath = path.join(
      devFixture.root,
      "dist",
      "plugin-sdk",
      "codex-mcp-projection.js",
    );
    const devCodexNativeTaskRuntimePath = path.join(
      devFixture.root,
      "dist",
      "plugin-sdk",
      "codex-native-task-runtime.js",
    );
    mkdirSafeDir(path.join(devFixture.root, "extensions"));
    fs.writeFileSync(devRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(
      devCodexMcpProjectionPath,
      "export const devCodexMcpProjection = true;\n",
      "utf-8",
    );
    fs.writeFileSync(
      devCodexNativeTaskRuntimePath,
      "export const devCodexNativeTaskRuntime = true;\n",
      "utf-8",
    );
    const { packageRoot: installedCodexRoot, pluginEntry: installedCodexEntry } =
      writeInstalledPluginEntry({
        installRoot: path.join(makeTempDir(), ".openclaw", "npm"),
        packageName: "@openclaw/codex",
      });
    const { packageRoot: installedOtherRoot, pluginEntry: installedOtherEntry } =
      writeInstalledPluginEntry({
        installRoot: path.join(makeTempDir(), ".openclaw", "npm"),
        packageName: "@openclaw/demo",
      });
    const shadowCodexRoot = path.join(makeTempDir(), ".openclaw", "extensions", "codex-shadow");
    const shadowCodexEntry = path.join(shadowCodexRoot, "dist", "index.js");
    mkdirSafeDir(path.dirname(shadowCodexEntry));
    fs.writeFileSync(
      path.join(shadowCodexRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", type: "module" }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(shadowCodexEntry, 'export const plugin = "shadow";\n', "utf-8");

    const aliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourcePluginEntry),
    );
    const otherAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourceOtherPluginEntry),
    );
    const devRootAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () =>
        buildPluginLoaderAliasMap(
          distCodexEntry,
          path.join(fixture.root, "openclaw.mjs"),
          undefined,
          "dist",
          devFixture.root,
        ),
    );
    const installedAliases = withCwd(installedCodexRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          installedCodexEntry,
          path.join(fixture.root, "openclaw.mjs"),
          undefined,
          "dist",
        ),
      ),
    );
    const shadowCodexAliases = withCwd(shadowCodexRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          shadowCodexEntry,
          path.join(fixture.root, "openclaw.mjs"),
          undefined,
          "dist",
        ),
      ),
    );
    const installedOtherAliases = withCwd(installedOtherRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          installedOtherEntry,
          path.join(fixture.root, "openclaw.mjs"),
          undefined,
          "dist",
        ),
      ),
    );

    expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/codex-mcp-projection"] ?? "")).toBe(
      fs.realpathSync(sourceCodexMcpProjectionPath),
    );
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/codex-native-task-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceCodexNativeTaskRuntimePath),
    );
    expect(
      fs.realpathSync(installedAliases["openclaw/plugin-sdk/codex-mcp-projection"] ?? ""),
    ).toBe(fs.realpathSync(distCodexMcpProjectionPath));
    expect(
      fs.realpathSync(installedAliases["openclaw/plugin-sdk/codex-native-task-runtime"] ?? ""),
    ).toBe(fs.realpathSync(distCodexNativeTaskRuntimePath));
    expect(fs.realpathSync(devRootAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(devRootAlias),
    );
    expect(fs.realpathSync(devRootAliases["openclaw/plugin-sdk/codex-mcp-projection"] ?? "")).toBe(
      fs.realpathSync(devCodexMcpProjectionPath),
    );
    expect(
      fs.realpathSync(devRootAliases["openclaw/plugin-sdk/codex-native-task-runtime"] ?? ""),
    ).toBe(fs.realpathSync(devCodexNativeTaskRuntimePath));
    expect(aliases["openclaw/plugin-sdk/qa-runtime"]).toBeUndefined();
    expect(otherAliases["openclaw/plugin-sdk/codex-mcp-projection"]).toBeUndefined();
    expect(otherAliases["openclaw/plugin-sdk/codex-native-task-runtime"]).toBeUndefined();
    expect(installedOtherAliases["openclaw/plugin-sdk/codex-mcp-projection"]).toBeUndefined();
    expect(installedOtherAliases["openclaw/plugin-sdk/codex-native-task-runtime"]).toBeUndefined();
    expect(shadowCodexAliases["openclaw/plugin-sdk/codex-mcp-projection"]).toBeUndefined();
    expect(shadowCodexAliases["openclaw/plugin-sdk/codex-native-task-runtime"]).toBeUndefined();
  });

  it("aliases the SSRF internal helper only for bundled local IPC owner plugins", async () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    writePluginSdkSubpathArtifacts(fixture.root, ["core"]);
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    const sourceSsrFInternalPath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "ssrf-runtime-internal.ts",
    );
    const distSsrFInternalPath = path.join(
      fixture.root,
      "dist",
      "plugin-sdk",
      "ssrf-runtime-internal.js",
    );
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(distRootAlias, "module.exports = {};\n", "utf-8");
    fs.rmSync(path.join(fixture.root, "scripts"), { force: true, recursive: true });
    fs.writeFileSync(sourceSsrFInternalPath, "export const ssrfInternal = true;\n", "utf-8");
    fs.writeFileSync(distSsrFInternalPath, "export const ssrfInternal = true;\n", "utf-8");
    const sourceOllamaEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("ollama", "index.ts"),
    );
    const sourceBrowserEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("browser", "index.ts"),
    );
    const sourceOtherPluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "index.ts"),
    );
    const entryBody = [
      'import { ssrfInternal } from "openclaw/plugin-sdk/ssrf-runtime-internal";',
      "export const loadedSsrFInternal = ssrfInternal;",
      "",
    ].join("\n");
    fs.writeFileSync(sourceOllamaEntry, entryBody, "utf-8");
    fs.writeFileSync(sourceBrowserEntry, entryBody, "utf-8");
    fs.writeFileSync(sourceOtherPluginEntry, entryBody, "utf-8");
    const distOllamaEntry = writePluginEntry(
      fixture.root,
      bundledDistPluginFile("ollama", "index.js"),
    );
    const distBrowserEntry = writePluginEntry(
      fixture.root,
      bundledDistPluginFile("browser", "index.js"),
    );
    const distRuntimeOllamaEntry = writePluginEntry(
      fixture.root,
      path.join("dist-runtime", "extensions", "ollama", "index.js"),
    );
    const distRuntimeBrowserEntry = writePluginEntry(
      fixture.root,
      path.join("dist-runtime", "extensions", "browser", "index.js"),
    );
    fs.writeFileSync(distOllamaEntry, entryBody, "utf-8");
    fs.writeFileSync(distBrowserEntry, entryBody, "utf-8");
    fs.writeFileSync(distRuntimeOllamaEntry, entryBody, "utf-8");
    fs.writeFileSync(distRuntimeBrowserEntry, entryBody, "utf-8");
    const { packageRoot: installedOllamaRoot, pluginEntry: installedOllamaEntry } =
      writeInstalledPluginEntry({
        installRoot: path.join(makeTempDir(), ".openclaw", "npm"),
        packageName: "@openclaw/ollama",
      });

    const sourceSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: sourceOllamaEntry,
      }),
    );
    const sourceBrowserSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: sourceBrowserEntry,
      }),
    );
    const privateQaOtherSubpaths = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" }, () =>
      listPluginSdkExportedSubpaths({
        modulePath: sourceOtherPluginEntry,
      }),
    );
    const sourceAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourceOllamaEntry),
    );
    const sourceBrowserAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourceBrowserEntry),
    );
    const distAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(distOllamaEntry, undefined, undefined, "dist"),
    );
    const distBrowserAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(distBrowserEntry, undefined, undefined, "dist"),
    );
    const distRuntimeAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(distRuntimeOllamaEntry, undefined, undefined, "dist"),
    );
    const distRuntimeBrowserAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(distRuntimeBrowserEntry, undefined, undefined, "dist"),
    );
    const otherAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourceOtherPluginEntry),
    );
    const privateQaOtherAliases = withEnv(
      { OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1", NODE_ENV: undefined },
      () => buildPluginLoaderAliasMap(sourceOtherPluginEntry),
    );
    const installedAliases = withCwd(installedOllamaRoot, () =>
      withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined, NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          installedOllamaEntry,
          path.join(fixture.root, "openclaw.mjs"),
          undefined,
          "dist",
        ),
      ),
    );

    expect(sourceSubpaths).toEqual(["core", "ssrf-runtime-internal"]);
    expect(sourceBrowserSubpaths).toEqual(["core", "ssrf-runtime-internal"]);
    expect(privateQaOtherSubpaths).toEqual(["core"]);
    expect(fs.realpathSync(sourceAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? "")).toBe(
      fs.realpathSync(sourceSsrFInternalPath),
    );
    expect(
      fs.realpathSync(sourceBrowserAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? ""),
    ).toBe(fs.realpathSync(sourceSsrFInternalPath));
    expect(fs.realpathSync(distAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? "")).toBe(
      fs.realpathSync(distSsrFInternalPath),
    );
    expect(
      fs.realpathSync(distBrowserAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? ""),
    ).toBe(fs.realpathSync(distSsrFInternalPath));
    expect(
      fs.realpathSync(distRuntimeAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? ""),
    ).toBe(fs.realpathSync(distSsrFInternalPath));
    expect(
      fs.realpathSync(distRuntimeBrowserAliases["openclaw/plugin-sdk/ssrf-runtime-internal"] ?? ""),
    ).toBe(fs.realpathSync(distSsrFInternalPath));
    expect(otherAliases["openclaw/plugin-sdk/ssrf-runtime-internal"]).toBeUndefined();
    expect(privateQaOtherAliases["openclaw/plugin-sdk/ssrf-runtime-internal"]).toBeUndefined();
    expect(installedAliases["openclaw/plugin-sdk/ssrf-runtime-internal"]).toBeUndefined();

    const createJiti = await getCreateJiti();
    const sourceLoaderBaseUrl = pathToFileURL(
      path.join(fixture.root, "src", "plugins", "loader.ts"),
    ).href;
    const ollamaLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(sourceAliases),
      tryNative: false,
    });
    const loadedOllama = ollamaLoader(sourceOllamaEntry) as { loadedSsrFInternal?: unknown };
    expect(loadedOllama.loadedSsrFInternal).toBe(true);
    const browserLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(sourceBrowserAliases),
      tryNative: false,
    });
    const loadedBrowser = browserLoader(sourceBrowserEntry) as { loadedSsrFInternal?: unknown };
    expect(loadedBrowser.loadedSsrFInternal).toBe(true);

    const distLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(distAliases),
      tryNative: true,
    });
    const loadedDistOllama = distLoader(distOllamaEntry) as {
      loadedSsrFInternal?: unknown;
    };
    expect(loadedDistOllama.loadedSsrFInternal).toBe(true);
    const distBrowserLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(distBrowserAliases),
      tryNative: true,
    });
    const loadedDistBrowser = distBrowserLoader(distBrowserEntry) as {
      loadedSsrFInternal?: unknown;
    };
    expect(loadedDistBrowser.loadedSsrFInternal).toBe(true);

    const distRuntimeLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(distRuntimeAliases),
      tryNative: true,
    });
    const loadedDistRuntimeOllama = distRuntimeLoader(distRuntimeOllamaEntry) as {
      loadedSsrFInternal?: unknown;
    };
    expect(loadedDistRuntimeOllama.loadedSsrFInternal).toBe(true);
    const distRuntimeBrowserLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(distRuntimeBrowserAliases),
      tryNative: true,
    });
    const loadedDistRuntimeBrowser = distRuntimeBrowserLoader(distRuntimeBrowserEntry) as {
      loadedSsrFInternal?: unknown;
    };
    expect(loadedDistRuntimeBrowser.loadedSsrFInternal).toBe(true);

    const otherLoader = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions(privateQaOtherAliases),
      tryNative: false,
    });
    let otherLoadError: unknown;
    try {
      otherLoader(sourceOtherPluginEntry);
    } catch (error) {
      otherLoadError = error;
    }
    expect(otherLoadError).toBeInstanceOf(Error);
    expect((otherLoadError as Error).message).toContain("ssrf-runtime-internal");
  });

  it("applies explicit dist resolution to plugin-sdk subpath aliases too", () => {
    const { fixture, distRootAlias, distChannelRuntimePath } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expectPluginSdkAliasTargets(distAliases, {
      rootAliasPath: distRootAlias,
      channelRuntimePath: distChannelRuntimePath,
    });
  });

  it("aliases workspace packages to source when dist artifacts are missing", () => {
    const fixture = createPluginSdkAliasFixture();
    const gatewayClient = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-client",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const gatewayClientTimeouts = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-client",
      srcFile: "timeouts.ts",
      distFile: "timeouts.mjs",
    });
    const gatewayProtocol = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-protocol",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const gatewayProtocolSchema = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-protocol",
      srcFile: "schema.ts",
      distFile: "schema.mjs",
    });
    const gatewayProtocolFrameGuards = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-protocol",
      srcFile: "frame-guards.ts",
      distFile: "frame-guards.mjs",
    });
    const netPolicy = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "net-policy",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const mediaGenerationCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "media-generation-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const mediaCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "media-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const mediaCoreMime = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "media-core",
      srcFile: "mime.ts",
      distFile: "mime.mjs",
    });
    const acpCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "acp-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const acpCoreRuntimeTypes = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "acp-core",
      srcFile: path.join("runtime", "types.ts"),
      distFile: path.join("runtime", "types.mjs"),
    });
    const normalizationCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const normalizationBooleanCoercion = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "boolean-coercion.ts",
      distFile: "boolean-coercion.mjs",
    });
    const normalizationResult = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "result.ts",
      distFile: "result.mjs",
    });
    const normalizationAgentId = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "agent-id.ts",
      distFile: "agent-id.mjs",
    });
    const normalizationStringCoerce = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "string-coerce.ts",
      distFile: "string-coerce.mjs",
    });
    const retry = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "retry",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const markdownCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "markdown-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const markdownCoreTables = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "markdown-core",
      srcFile: "tables.ts",
      distFile: "tables.mjs",
    });
    const mediaGenerationModelRef = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "media-generation-core",
      srcFile: "model-ref.ts",
      distFile: "model-ref.mjs",
    });
    const terminalCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "terminal-core",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const terminalCoreTheme = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "terminal-core",
      srcFile: "theme.ts",
      distFile: "theme.mjs",
    });
    const netPolicyIp = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "net-policy",
      srcFile: "ip.ts",
      distFile: "ip.mjs",
    });
    const netPolicyUrlProtocol = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "net-policy",
      srcFile: "url-protocol.ts",
      distFile: "url-protocol.mjs",
    });
    const modelCatalogProviderId = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "model-catalog-core",
      srcFile: "provider-id.ts",
      distFile: "provider-id.mjs",
    });
    fs.rmSync(gatewayClient.distFile);
    fs.rmSync(gatewayClientTimeouts.distFile);
    fs.rmSync(gatewayProtocol.distFile);
    fs.rmSync(gatewayProtocolSchema.distFile);
    fs.rmSync(gatewayProtocolFrameGuards.distFile);
    fs.rmSync(markdownCore.distFile);
    fs.rmSync(markdownCoreTables.distFile);
    fs.rmSync(mediaGenerationCore.distFile);
    fs.rmSync(mediaGenerationModelRef.distFile);
    fs.rmSync(mediaCore.distFile);
    fs.rmSync(mediaCoreMime.distFile);
    fs.rmSync(acpCore.distFile);
    fs.rmSync(acpCoreRuntimeTypes.distFile);
    fs.rmSync(normalizationCore.distFile);
    fs.rmSync(normalizationBooleanCoercion.distFile);
    fs.rmSync(normalizationResult.distFile);
    fs.rmSync(normalizationAgentId.distFile);
    fs.rmSync(normalizationStringCoerce.distFile);
    fs.rmSync(retry.distFile);
    fs.rmSync(terminalCore.distFile);
    fs.rmSync(terminalCoreTheme.distFile);
    fs.rmSync(netPolicy.distFile);
    fs.rmSync(netPolicyIp.distFile);
    fs.rmSync(netPolicyUrlProtocol.distFile);
    fs.rmSync(modelCatalogProviderId.distFile);
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const aliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expect(fs.realpathSync(aliases["@openclaw/gateway-client"] ?? "")).toBe(
      fs.realpathSync(gatewayClient.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-client/timeouts"] ?? "")).toBe(
      fs.realpathSync(gatewayClientTimeouts.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-protocol"] ?? "")).toBe(
      fs.realpathSync(gatewayProtocol.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-protocol/schema"] ?? "")).toBe(
      fs.realpathSync(gatewayProtocolSchema.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-protocol/frame-guards"] ?? "")).toBe(
      fs.realpathSync(gatewayProtocolFrameGuards.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/markdown-core"] ?? "")).toBe(
      fs.realpathSync(markdownCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/markdown-core/tables"] ?? "")).toBe(
      fs.realpathSync(markdownCoreTables.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/media-generation-core"] ?? "")).toBe(
      fs.realpathSync(mediaGenerationCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/media-generation-core/model-ref"] ?? "")).toBe(
      fs.realpathSync(mediaGenerationModelRef.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/media-core"] ?? "")).toBe(
      fs.realpathSync(mediaCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/media-core/mime"] ?? "")).toBe(
      fs.realpathSync(mediaCoreMime.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/acp-core"] ?? "")).toBe(
      fs.realpathSync(acpCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/acp-core/runtime/types"] ?? "")).toBe(
      fs.realpathSync(acpCoreRuntimeTypes.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core"] ?? "")).toBe(
      fs.realpathSync(normalizationCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/boolean-coercion"] ?? "")).toBe(
      fs.realpathSync(normalizationBooleanCoercion.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/result"] ?? "")).toBe(
      fs.realpathSync(normalizationResult.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/agent-id"] ?? "")).toBe(
      fs.realpathSync(normalizationAgentId.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/string-coerce"] ?? "")).toBe(
      fs.realpathSync(normalizationStringCoerce.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/retry"] ?? "")).toBe(fs.realpathSync(retry.srcFile));
    expect(fs.realpathSync(aliases["@openclaw/terminal-core"] ?? "")).toBe(
      fs.realpathSync(terminalCore.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/terminal-core/theme"] ?? "")).toBe(
      fs.realpathSync(terminalCoreTheme.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/net-policy"] ?? "")).toBe(
      fs.realpathSync(netPolicy.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/net-policy/ip"] ?? "")).toBe(
      fs.realpathSync(netPolicyIp.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/net-policy/url-protocol"] ?? "")).toBe(
      fs.realpathSync(netPolicyUrlProtocol.srcFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/model-catalog-core/provider-id"] ?? "")).toBe(
      fs.realpathSync(modelCatalogProviderId.srcFile),
    );
  });

  it("aliases workspace package subpaths to dist when available", () => {
    const fixture = createPluginSdkAliasFixture();
    const gatewayClient = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-client",
      srcFile: "readiness.ts",
      distFile: "readiness.mjs",
    });
    const gatewayProtocol = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-protocol",
      srcFile: "connect-error-details.ts",
      distFile: "connect-error-details.mjs",
    });
    const gatewayProtocolFrameGuards = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "gateway-protocol",
      srcFile: "frame-guards.ts",
      distFile: "frame-guards.mjs",
    });
    const mediaGenerationCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "media-generation-core",
      srcFile: "catalog.ts",
      distFile: "catalog.mjs",
    });
    writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "acp-core",
      srcFile: "normalize-text.ts",
      distFile: "normalize-text.mjs",
    });
    const acpCoreRootDistFile = path.join(fixture.root, "dist", "acp-core", "normalize-text.js");
    mkdirSafeDir(path.dirname(acpCoreRootDistFile));
    fs.writeFileSync(acpCoreRootDistFile, "export {};\n", "utf-8");
    writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "normalization-core",
      srcFile: "record-coerce.ts",
      distFile: "record-coerce.mjs",
    });
    const normalizationCoreRootDistFile = path.join(
      fixture.root,
      "dist",
      "normalization-core",
      "record-coerce.js",
    );
    mkdirSafeDir(path.dirname(normalizationCoreRootDistFile));
    fs.writeFileSync(normalizationCoreRootDistFile, "export {};\n", "utf-8");
    writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "retry",
      srcFile: "index.ts",
      distFile: "index.mjs",
    });
    const retryRootDistFile = path.join(fixture.root, "dist", "retry", "index.js");
    mkdirSafeDir(path.dirname(retryRootDistFile));
    fs.writeFileSync(retryRootDistFile, "export {};\n", "utf-8");
    const markdownCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "markdown-core",
      srcFile: "render.ts",
      distFile: "render.mjs",
    });
    const ignoredTerminalCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "terminal-core",
      srcFile: "links.ts",
      distFile: "links.mjs",
    });
    void ignoredTerminalCore;
    const terminalCoreRootDistFile = path.join(fixture.root, "dist", "terminal-core", "links.js");
    mkdirSafeDir(path.dirname(terminalCoreRootDistFile));
    fs.writeFileSync(terminalCoreRootDistFile, "export {};\n", "utf-8");
    const netPolicy = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "net-policy",
      srcFile: "url-protocol.ts",
      distFile: "url-protocol.mjs",
    });
    const modelCatalogCore = writeWorkspacePackageEntry({
      root: fixture.root,
      packageDir: "model-catalog-core",
      srcFile: "provider-model-id-normalize.ts",
      distFile: "provider-model-id-normalize.mjs",
    });
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const aliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expect(fs.realpathSync(aliases["@openclaw/gateway-client/readiness"] ?? "")).toBe(
      fs.realpathSync(gatewayClient.distFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-protocol/connect-error-details"] ?? "")).toBe(
      fs.realpathSync(gatewayProtocol.distFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/gateway-protocol/frame-guards"] ?? "")).toBe(
      fs.realpathSync(gatewayProtocolFrameGuards.distFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/markdown-core/render"] ?? "")).toBe(
      fs.realpathSync(markdownCore.distFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/media-generation-core/catalog"] ?? "")).toBe(
      fs.realpathSync(mediaGenerationCore.distFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/acp-core/normalize-text"] ?? "")).toBe(
      fs.realpathSync(acpCoreRootDistFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/record-coerce"] ?? "")).toBe(
      fs.realpathSync(normalizationCoreRootDistFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/retry"] ?? "")).toBe(
      fs.realpathSync(retryRootDistFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/terminal-core/links"] ?? "")).toBe(
      fs.realpathSync(terminalCoreRootDistFile),
    );
    expect(fs.realpathSync(aliases["@openclaw/net-policy/url-protocol"] ?? "")).toBe(
      fs.realpathSync(netPolicy.distFile),
    );
    expect(
      fs.realpathSync(aliases["@openclaw/model-catalog-core/provider-model-id-normalize"] ?? ""),
    ).toBe(fs.realpathSync(modelCatalogCore.distFile));
  });

  it("derives workspace aliases from packaged root dist when package metadata is absent", () => {
    const fixture = createPluginSdkAliasFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );
    const acpRuntimeErrors = path.join(fixture.root, "dist", "acp-core", "runtime", "errors.js");
    mkdirSafeDir(path.dirname(acpRuntimeErrors));
    fs.writeFileSync(acpRuntimeErrors, "export {};\n", "utf-8");
    const normalizationAgentId = path.join(
      fixture.root,
      "dist",
      "normalization-core",
      "agent-id.js",
    );
    mkdirSafeDir(path.dirname(normalizationAgentId));
    fs.writeFileSync(normalizationAgentId, "export {};\n", "utf-8");
    const cwdWithoutOpenClawPackage = makeTempDir();

    const aliases = withCwd(cwdWithoutOpenClawPackage, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
      ),
    );

    expect(fs.realpathSync(aliases["@openclaw/acp-core/runtime/errors"] ?? "")).toBe(
      fs.realpathSync(acpRuntimeErrors),
    );
    expect(fs.realpathSync(aliases["@openclaw/normalization-core/agent-id"] ?? "")).toBe(
      fs.realpathSync(normalizationAgentId),
    );
  });

  it("aliases bundled plugin package public surfaces for source plugin transforms", () => {
    const { fixture, sourceApiPath, sourceRuntimeApiPath } =
      createBundledPluginPackagePublicSurfaceAliasFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("qa-lab", "src/live-transports/slack/slack-live.runtime.ts"),
    );

    const aliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );

    expect(fs.realpathSync(aliases["@openclaw/slack/api.js"] ?? "")).toBe(
      fs.realpathSync(sourceApiPath),
    );
    expect(fs.realpathSync(aliases["@openclaw/slack/runtime-api.js"] ?? "")).toBe(
      fs.realpathSync(sourceRuntimeApiPath),
    );
    expect(aliases["@openclaw/slack/test-api.js"]).toBeUndefined();
    expect(aliases["@openclaw/slack/internal.js"]).toBeUndefined();
  });

  it("aliases bundled plugin package test surfaces only in private QA mode", () => {
    const { fixture, sourceTestApiPath } = createBundledPluginPackagePublicSurfaceAliasFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("qa-lab", "src/live-transports/slack/slack-live.runtime.ts"),
    );

    const aliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1", NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );

    expect(fs.realpathSync(aliases["@openclaw/slack/test-api.js"] ?? "")).toBe(
      fs.realpathSync(sourceTestApiPath),
    );
  });

  it("aliases bundled plugin package public surfaces to dist when dist resolution is requested", () => {
    const { fixture, distApiPath, distRuntimeApiPath } =
      createBundledPluginPackagePublicSurfaceAliasFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("qa-lab", "src/live-transports/slack/slack-live.runtime.ts"),
    );

    const aliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expect(fs.realpathSync(aliases["@openclaw/slack/api.js"] ?? "")).toBe(
      fs.realpathSync(distApiPath),
    );
    expect(fs.realpathSync(aliases["@openclaw/slack/runtime-api.js"] ?? "")).toBe(
      fs.realpathSync(distRuntimeApiPath),
    );
  });

  it("falls back to source plugin-sdk subpath aliases when dist chunks are stale", () => {
    const fixture = createPluginSdkAliasFixture({
      srcFile: "provider-entry.ts",
      distFile: "provider-entry.js",
      distBody: 'import { entry } from "../missing-provider-entry-chunk.js";\nexport { entry };\n',
      packageExports: {
        "./plugin-sdk/provider-entry": { default: "./dist/plugin-sdk/provider-entry.js" },
      },
    });
    const sourceProviderEntryPath = path.join(
      fixture.root,
      "src",
      "plugin-sdk",
      "provider-entry.ts",
    );
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expect(fs.realpathSync(distAliases["openclaw/plugin-sdk/provider-entry"] ?? "")).toBe(
      fs.realpathSync(sourceProviderEntryPath),
    );
  });

  it("builds source plugin-sdk subpath aliases through the wider source extension family", () => {
    const { fixture, sourceRootAlias, sourceChannelRuntimePath } =
      createPluginSdkAliasTargetFixture({
        sourceChannelRuntimeExtension: ".mts",
      });
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const sourceAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );

    expectPluginSdkAliasTargets(sourceAliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: sourceChannelRuntimePath,
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via the running openclaw argv hint", () => {
    const {
      externalPluginEntry,
      externalPluginRoot,
      fixture,
      sourcePluginEntryPath,
      sourceRootAlias,
      sourceChannelRuntimePath,
    } = createUserInstalledPluginSdkAliasFixture();

    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(externalPluginEntry, path.join(fixture.root, "openclaw.mjs")),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: sourceChannelRuntimePath,
      pluginEntryPath: sourcePluginEntryPath,
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via moduleUrl hint", () => {
    const {
      externalPluginEntry,
      externalPluginRoot,
      fixture,
      sourcePluginEntryPath,
      sourceRootAlias,
      sourceChannelRuntimePath,
    } = createUserInstalledPluginSdkAliasFixture();

    // Simulate loader.ts passing its own import.meta.url as the moduleUrl hint.
    // This covers installations where argv1 does not resolve to the openclaw root
    // (e.g. single-binary distributions or custom process launchers).
    // Use openclaw.mjs which is created by createPluginSdkAliasFixture (bin+marker mode).
    // Use fixture.root as cwd so process.cwd() fallback also resolves to fixture, not the
    // real openclaw repo root in the test runner environment.
    const loaderModuleUrl = pathToFileURL(path.join(fixture.root, "openclaw.mjs")).href;

    // Use externalPluginRoot as cwd so process.cwd() fallback cannot accidentally
    // resolve to the fixture root — only the moduleUrl hint can bridge the gap.
    // Pass "" for argv1: undefined would trigger the STARTUP_ARGV1 default (the vitest
    // runner binary, inside the openclaw repo), which resolves before moduleUrl is checked.
    // An empty string is falsy so resolveTrustedOpenClawRootFromArgvHint returns null,
    // meaning only the moduleUrl hint can bridge the gap.
    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          externalPluginEntry,
          "", // explicitly disable argv1 (empty string bypasses STARTUP_ARGV1 default)
          loaderModuleUrl,
        ),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      rootAliasPath: sourceRootAlias,
      channelRuntimePath: sourceChannelRuntimePath,
      pluginEntryPath: sourcePluginEntryPath,
    });
  });

  it.each([
    {
      name: "does not resolve plugin-sdk alias files from cwd fallback when package root is not an OpenClaw root",
      fixture: () =>
        createPluginSdkAliasFixture({
          srcFile: "channel-runtime.ts",
          distFile: "channel-runtime.js",
          trustedRootIndicators: false,
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
        }),
      expected: null,
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    expectCwdFallbackPluginSdkAliasResolution({
      fixture,
      expected,
    });
  });

  it("configures the plugin loader native-first boundary to prefer native dist modules", () => {
    const options = buildPluginLoaderJitiOptions({});

    expect(options.tryNative).toBe(true);
    expect(options.nativeModules).toEqual(["openclaw"]);
    expect(options.interopDefault).toBe(true);
    expect(options.extensions).toContain(".js");
    expect(options.extensions).toContain(".ts");
    expect("alias" in options).toBe(false);
  });

  it("preserves configured jiti native modules while adding openclaw", () => {
    const options = withEnv(
      { JITI_NATIVE_MODULES: JSON.stringify(["native-addon", "openclaw"]) },
      () => buildPluginLoaderJitiOptions({}),
    );

    expect(options.nativeModules).toEqual(["native-addon", "openclaw"]);
  });

  it("uses transpiled module loads for source TypeScript plugin entries", () => {
    expect(shouldPreferNativeModuleLoad("/repo/dist/plugins/runtime/index.js")).toBe(true);
    expect(
      shouldPreferNativeModuleLoad(
        `/repo/${bundledPluginFile("discord", "src/channel.runtime.ts")}`,
      ),
    ).toBe(false);
  });

  it("disables native module loads under Bun even for built JavaScript entries", () => {
    const originalVersions = process.versions;
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: {
        ...originalVersions,
        bun: "1.2.0",
      },
    });

    try {
      expect(shouldPreferNativeModuleLoad("/repo/dist/plugins/runtime/index.js")).toBe(false);
      expect(
        shouldPreferNativeModuleLoad(`/repo/${bundledDistPluginFile("browser", "index.js")}`),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "versions", {
        configurable: true,
        value: originalVersions,
      });
    }
  });

  it("enables native module loads on Windows for built JavaScript entries", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      expect(shouldPreferNativeModuleLoad("/repo/dist/plugins/runtime/index.js")).toBe(true);
      expect(
        shouldPreferNativeModuleLoad(`/repo/${bundledDistPluginFile("browser", "index.js")}`),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("keeps plugin loader dist shortcuts on native module loading on Windows for JS entries", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      expect(
        resolvePluginLoaderTryNative(`/repo/${bundledDistPluginFile("browser", "index.js")}`, {
          preferBuiltDist: true,
        }),
      ).toBe(true);
      expect(
        resolvePluginLoaderTryNative(`/repo/${bundledDistPluginFile("browser", "helper.ts")}`, {
          preferBuiltDist: true,
        }),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("prefers native module loading for bundled plugin dist .js modules, keeps .ts on aliased path", () => {
    // Built .js/.mjs/.cjs files under dist/extensions/ should now delegate
    // to shouldPreferNativeModuleLoad() — which returns true on Node for
    // compiled artifacts, avoiding the slow jiti transform path.
    expect(
      resolvePluginLoaderTryNative(`/repo/${bundledDistPluginFile("browser", "index.js")}`, {
        preferBuiltDist: true,
      }),
    ).toBe(true);
    // TypeScript source files still need jiti's transform pipeline.
    expect(
      resolvePluginLoaderTryNative(`/repo/${bundledDistPluginFile("browser", "helper.ts")}`, {
        preferBuiltDist: true,
      }),
    ).toBe(false);
    expect(
      resolvePluginLoaderTryNative("/repo/dist/plugins/runtime/index.js", {
        preferBuiltDist: true,
      }),
    ).toBe(true);
  });

  it("keeps plugin loader module cache keys stable across alias insertion order", () => {
    expect(
      createPluginLoaderModuleCacheKey({
        tryNative: true,
        aliasMap: {
          zeta: "/repo/zeta.js",
          alpha: "/repo/alpha.js",
        },
      }),
    ).toBe(
      createPluginLoaderModuleCacheKey({
        tryNative: true,
        aliasMap: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
      }),
    );
  });

  it("returns plugin loader module config with stable cache keys", () => {
    const first = resolvePluginLoaderModuleConfig({
      modulePath: `/repo/${bundledDistPluginFile("browser", "index.js")}`,
      argv1: "/repo/openclaw.mjs",
      moduleUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      preferBuiltDist: true,
    });
    const second = resolvePluginLoaderModuleConfig({
      modulePath: `/repo/${bundledDistPluginFile("browser", "index.js")}`,
      argv1: "/repo/openclaw.mjs",
      moduleUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      preferBuiltDist: true,
    });

    expect(second).toBe(first);
  });

  it("scopes plugin loader module config by plugin-sdk resolution", () => {
    const { fixture, sourceRootAlias, distRootAlias } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const { auto, dist, distAgain } = withEnv({ NODE_ENV: undefined }, () => ({
      auto: resolvePluginLoaderModuleConfig({
        modulePath: sourcePluginEntry,
        argv1: path.join(fixture.root, "openclaw.mjs"),
        moduleUrl: pathToFileURL(path.join(fixture.root, "src/plugins/loader.ts")).href,
        pluginSdkResolution: "auto",
      }),
      dist: resolvePluginLoaderModuleConfig({
        modulePath: sourcePluginEntry,
        argv1: path.join(fixture.root, "openclaw.mjs"),
        moduleUrl: pathToFileURL(path.join(fixture.root, "src/plugins/loader.ts")).href,
        pluginSdkResolution: "dist",
      }),
      distAgain: resolvePluginLoaderModuleConfig({
        modulePath: sourcePluginEntry,
        argv1: path.join(fixture.root, "openclaw.mjs"),
        moduleUrl: pathToFileURL(path.join(fixture.root, "src/plugins/loader.ts")).href,
        pluginSdkResolution: "dist",
      }),
    }));

    expect(distAgain).toBe(dist);
    expect(auto).not.toBe(dist);
    expect(fs.realpathSync(auto.aliasMap["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(dist.aliasMap["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(distRootAlias),
    );
  });

  it("loads source runtime shims through the non-native module loading boundary", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), bundledPluginRoot("discord"));
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafeDir(copiedSourceDir);
    mkdirSafeDir(copiedPluginSdkDir);
    const sourceLoaderBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(sourceLoaderBaseFile, "export {};\n", "utf-8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "@openclaw/plugin-sdk/channel-outbound";

export const syntheticRuntimeMarker = {
  resolveOutboundSendDep,
};
`,
      "utf-8",
    );
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "channel-outbound.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf-8",
    );
    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const sourceLoaderBaseUrl = pathToFileURL(sourceLoaderBaseFile).href;

    const createJiti = await getCreateJiti();
    const withoutAlias = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions({}),
      tryNative: false,
    });
    let loadError: unknown;
    try {
      withoutAlias(copiedChannelRuntime);
    } catch (error) {
      loadError = error;
    }
    expect(loadError).toBeInstanceOf(Error);
    expect((loadError as Error).message).toContain("channel-outbound");

    const withAlias = createJiti(sourceLoaderBaseUrl, {
      ...buildPluginLoaderJitiOptions({
        "openclaw/plugin-sdk/channel-outbound": copiedChannelRuntimeShim,
        "@openclaw/plugin-sdk/channel-outbound": copiedChannelRuntimeShim,
      }),
      tryNative: false,
    });
    const loadedRuntime = withAlias(copiedChannelRuntime) as {
      syntheticRuntimeMarker?: { resolveOutboundSendDep?: unknown };
    };
    expect(typeof loadedRuntime.syntheticRuntimeMarker?.resolveOutboundSendDep).toBe("function");
  }, 240_000);

  it.each([
    {
      name: "prefers dist plugin runtime module when loader runs from dist",
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      expected: "dist" as const,
    },
    {
      name: "resolves plugin runtime module from package root when loader runs from transpiler cache path",
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
    },
  ])("$name", ({ modulePath, argv1, env, expected }) => {
    const fixture = createPluginRuntimeAliasFixture();
    const resolved = resolvePluginRuntimeModule({
      modulePath: modulePath(fixture.root),
      argv1: argv1?.(fixture.root),
      env,
    });
    expect(resolved).toBe(expected === "dist" ? fixture.distFile : fixture.srcFile);
  });

  it("resolves plugin runtime modules from an explicit dev source root", () => {
    const stableFixture = createPluginRuntimeAliasFixture({
      distBody: "export const stableRuntime = true;\n",
    });
    const devFixture = createPluginRuntimeAliasFixture({
      distBody: "export const devRuntime = true;\n",
    });
    mkdirSafeDir(path.join(devFixture.root, "extensions"));
    const entry = path.join(stableFixture.root, "dist", "plugins", "loader.js");
    mkdirSafeDir(path.dirname(entry));
    fs.writeFileSync(entry, "export {};\n", "utf-8");

    const resolved = resolvePluginRuntimeModule({
      modulePath: entry,
      pluginSdkResolution: "dist",
      devSourceRoot: devFixture.root,
    });

    expect(fs.realpathSync(resolved ?? "")).toBe(fs.realpathSync(devFixture.distFile));
  });

  it("falls back to ancestor runtime candidates when package-root markers are unavailable", () => {
    const root = makeTempDir();
    const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
    const loaderCachePath = path.join(root, ".cache", "tsx", "openclaw-loader.js");
    mkdirSafeDir(path.dirname(distFile));
    mkdirSafeDir(path.dirname(loaderCachePath));
    fs.writeFileSync(distFile, "export const createPluginRuntime = () => ({});\n", "utf-8");
    fs.writeFileSync(loaderCachePath, "export {};\n", "utf-8");

    expect(
      resolvePluginRuntimeModule({
        modulePath: loaderCachePath,
        argv1: path.join(root, "bin", "openclaw"),
        pluginSdkResolution: "dist",
      }),
    ).toBe(distFile);
  });

  it("uses the default startup argv hint for runtime fallback when argv1 is omitted", () => {
    const root = makeTempDir();
    const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
    const loaderCacheRoot = makeTempDir();
    const loaderCachePath = path.join(loaderCacheRoot, "tsx", "openclaw-loader.js");
    const originalArgv1 = process.argv[1];
    mkdirSafeDir(path.dirname(distFile));
    mkdirSafeDir(path.dirname(loaderCachePath));
    mkdirSafeDir(path.join(root, "bin"));
    fs.writeFileSync(distFile, "export const createPluginRuntime = () => ({});\n", "utf-8");
    fs.writeFileSync(loaderCachePath, "export {};\n", "utf-8");

    process.argv[1] = path.join(root, "bin", "openclaw");
    try {
      expect(
        resolvePluginRuntimeModule({
          modulePath: loaderCachePath,
          pluginSdkResolution: "dist",
        }),
      ).toBe(distFile);
    } finally {
      if (originalArgv1 === undefined) {
        process.argv.splice(1, 1);
      } else {
        process.argv[1] = originalArgv1;
      }
    }
  });

  it("prefers startup argv runtime candidates over cache ancestor fallbacks", () => {
    const root = makeTempDir();
    const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
    const loaderCacheRoot = makeTempDir();
    const cacheDistFile = path.join(loaderCacheRoot, "dist", "plugins", "runtime", "index.js");
    const loaderCachePath = path.join(loaderCacheRoot, "tsx", "openclaw-loader.js");
    mkdirSafeDir(path.dirname(distFile));
    mkdirSafeDir(path.dirname(cacheDistFile));
    mkdirSafeDir(path.dirname(loaderCachePath));
    mkdirSafeDir(path.join(root, "bin"));
    fs.writeFileSync(distFile, "export const runtime = 'startup';\n", "utf-8");
    fs.writeFileSync(cacheDistFile, "export const runtime = 'cache';\n", "utf-8");
    fs.writeFileSync(loaderCachePath, "export {};\n", "utf-8");

    expect(
      resolvePluginRuntimeModule({
        modulePath: loaderCachePath,
        argv1: path.join(root, "bin", "openclaw"),
        pluginSdkResolution: "dist",
      }),
    ).toBe(distFile);
  });

  it("resolves runtime fallback through symlinked startup argv", () => {
    const root = makeTempDir();
    const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
    const binFile = path.join(root, "bin", "openclaw");
    const shimRoot = makeTempDir();
    const shimFile = path.join(shimRoot, "bin", "openclaw");
    const loaderCachePath = path.join(makeTempDir(), "tsx", "openclaw-loader.js");
    mkdirSafeDir(path.dirname(distFile));
    mkdirSafeDir(path.dirname(binFile));
    mkdirSafeDir(path.dirname(shimFile));
    mkdirSafeDir(path.dirname(loaderCachePath));
    fs.writeFileSync(distFile, "export const runtime = 'startup';\n", "utf-8");
    fs.writeFileSync(binFile, "#!/usr/bin/env node\n", "utf-8");
    fs.symlinkSync(binFile, shimFile);
    fs.writeFileSync(loaderCachePath, "export {};\n", "utf-8");

    expect(
      resolvePluginRuntimeModule({
        modulePath: loaderCachePath,
        argv1: shimFile,
        pluginSdkResolution: "dist",
      }),
    ).toBe(fs.realpathSync(distFile));
  });

  it("resolves runtime fallback through npm .bin startup argv", () => {
    const root = makeTempDir();
    const packageRoot = path.join(root, "node_modules", "openclaw");
    const distFile = path.join(packageRoot, "dist", "plugins", "runtime", "index.js");
    const projectDistFile = path.join(root, "dist", "plugins", "runtime", "index.js");
    const binFile = path.join(root, "node_modules", ".bin", "openclaw");
    const loaderCachePath = path.join(makeTempDir(), "tsx", "openclaw-loader.js");
    mkdirSafeDir(path.dirname(distFile));
    mkdirSafeDir(path.dirname(projectDistFile));
    mkdirSafeDir(path.dirname(binFile));
    mkdirSafeDir(path.dirname(loaderCachePath));
    fs.writeFileSync(distFile, "export const runtime = 'startup';\n", "utf-8");
    fs.writeFileSync(projectDistFile, "export const runtime = 'project';\n", "utf-8");
    fs.writeFileSync(binFile, "#!/usr/bin/env node\n", "utf-8");
    fs.writeFileSync(loaderCachePath, "export {};\n", "utf-8");

    expect(
      resolvePluginRuntimeModule({
        modulePath: loaderCachePath,
        argv1: binFile,
        pluginSdkResolution: "dist",
      }),
    ).toBe(distFile);
  });

  it("reports loader, package root, and candidate paths when runtime resolution fails", () => {
    const root = makeTempDir();
    const modulePath = path.join(root, "dist", "plugins", "loader.js");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf-8",
    );
    mkdirSafeDir(path.dirname(modulePath));
    fs.writeFileSync(modulePath, "export {};\n", "utf-8");

    const resolution = resolvePluginRuntimeModulePathWithDiagnostics({
      modulePath,
      pluginSdkResolution: "dist",
    });

    expect(resolution.resolvedPath).toBeNull();
    expect(resolution.modulePath).toBe(modulePath);
    expect(resolution.packageRoot).toBe(root);
    expect(resolution.candidates).toContain(
      path.join(root, "dist", "plugins", "runtime", "index.js"),
    );
    expect(resolution.candidates).toContain(
      path.join(root, "src", "plugins", "runtime", "index.ts"),
    );
  });
});

describe("buildPluginLoaderAliasMap memoization", () => {
  it("returns the same object reference for identical effective context", () => {
    const fixture = createPluginSdkAliasFixture();
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("memo-demo", "src/index.ts"),
    );

    const first = buildPluginLoaderAliasMap(sourcePluginEntry);
    const second = buildPluginLoaderAliasMap(sourcePluginEntry);

    expect(second).toBe(first);
  });

  it("returns different references for different modulePath inputs", () => {
    const fixtureA = createPluginSdkAliasFixture();
    const fixtureB = createPluginSdkAliasFixture();
    fs.writeFileSync(
      path.join(fixtureA.root, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(fixtureB.root, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf-8",
    );
    const entryA = writePluginEntry(fixtureA.root, bundledPluginFile("a", "src/index.ts"));
    const entryB = writePluginEntry(fixtureB.root, bundledPluginFile("b", "src/index.ts"));

    const aliasA = buildPluginLoaderAliasMap(entryA);
    const aliasB = buildPluginLoaderAliasMap(entryB);

    expect(aliasA).not.toBe(aliasB);
    expect(aliasA["openclaw/plugin-sdk"]).not.toBe(aliasB["openclaw/plugin-sdk"]);
  });

  it("returns different references when pluginSdkResolution differs", () => {
    const fixture = createPluginSdkAliasFixture();
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf-8",
    );
    const entry = writePluginEntry(fixture.root, bundledPluginFile("res", "src/index.ts"));

    const auto = buildPluginLoaderAliasMap(entry, undefined, undefined, "auto");
    const dist = buildPluginLoaderAliasMap(entry, undefined, undefined, "dist");

    expect(auto).not.toBe(dist);
  });

  it("returns different references when argv1 differs", () => {
    const fixture = createPluginSdkAliasFixture();
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf-8",
    );
    const entry = writePluginEntry(fixture.root, bundledPluginFile("argv", "src/index.ts"));

    const a = buildPluginLoaderAliasMap(entry, "/path/to/cli-a.mjs");
    const b = buildPluginLoaderAliasMap(entry, "/path/to/cli-b.mjs");

    expect(a).not.toBe(b);
  });

  it("returns different references when an explicit dev source root differs", () => {
    const stableFixture = createPluginSdkAliasFixture();
    const devFixture = createPluginSdkAliasFixture();
    const stableRootAlias = path.join(stableFixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    const devRootAlias = path.join(devFixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    mkdirSafeDir(path.join(devFixture.root, "extensions"));
    fs.writeFileSync(stableRootAlias, "module.exports = { stable: true };\n", "utf-8");
    fs.writeFileSync(devRootAlias, "module.exports = { dev: true };\n", "utf-8");
    const entry = writePluginEntry(
      stableFixture.root,
      bundledPluginFile("dev-env", "src/index.ts"),
    );

    const stableAliases = buildPluginLoaderAliasMap(entry, undefined, undefined, "dist", null);
    const devAliases = buildPluginLoaderAliasMap(
      entry,
      undefined,
      undefined,
      "dist",
      devFixture.root,
    );

    expect(devAliases).not.toBe(stableAliases);
    expect(fs.realpathSync(stableAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(stableRootAlias),
    );
    expect(fs.realpathSync(devAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(devRootAlias),
    );
  });

  it("does not reuse a public alias map after private qa aliases are enabled", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
      },
    });
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const sourceQaRuntimePath = path.join(fixture.root, "src", "plugin-sdk", "qa-runtime.ts");
    fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf-8");
    fs.writeFileSync(sourceQaRuntimePath, "export const qaRuntime = true;\n", "utf-8");
    const entry = writePluginEntry(fixture.root, bundledPluginFile("private-qa", "src/index.ts"));

    const publicAliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, () =>
      buildPluginLoaderAliasMap(entry),
    );
    const privateAliases = withEnv({ OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" }, () =>
      buildPluginLoaderAliasMap(entry),
    );

    expect(publicAliases).not.toBe(privateAliases);
    expect(publicAliases["openclaw/plugin-sdk/qa-runtime"]).toBeUndefined();
    expect(fs.realpathSync(privateAliases["openclaw/plugin-sdk/qa-runtime"] ?? "")).toBe(
      fs.realpathSync(sourceQaRuntimePath),
    );
  });

  it("does not reuse a development alias map in production mode", () => {
    const fixture = createPluginSdkAliasFixture();
    const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
    const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
    fs.writeFileSync(sourceRootAlias, "module.exports = { source: true };\n", "utf-8");
    fs.writeFileSync(distRootAlias, "module.exports = { dist: true };\n", "utf-8");
    const entry = writePluginEntry(fixture.root, bundledPluginFile("env-mode", "src/index.ts"));

    const developmentAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(entry),
    );
    const productionAliases = withEnv({ NODE_ENV: "production" }, () =>
      buildPluginLoaderAliasMap(entry),
    );

    expect(developmentAliases).not.toBe(productionAliases);
    expect(fs.realpathSync(developmentAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(sourceRootAlias),
    );
    expect(fs.realpathSync(productionAliases["openclaw/plugin-sdk"] ?? "")).toBe(
      fs.realpathSync(distRootAlias),
    );
  });

  it("memoized result has identical content to a freshly computed map", () => {
    const fixture = createPluginSdkAliasFixture();
    fs.writeFileSync(
      path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs"),
      "module.exports = {};\n",
      "utf-8",
    );
    const entry = writePluginEntry(fixture.root, bundledPluginFile("eq", "src/index.ts"));

    const first = buildPluginLoaderAliasMap(entry);
    const second = buildPluginLoaderAliasMap(entry);

    // Same reference (cache hit)
    expect(second).toBe(first);
    // Same content
    expect(second).toEqual(first);
    // Same key set
    expect(Object.keys(second).toSorted()).toEqual(Object.keys(first).toSorted());
  });
});

describe("buildPluginLoaderJitiOptions", () => {
  it("adds the versioned fs cache directory to plugin loader jiti options", () => {
    const root = createTrustedOpenClawPackageFixture("2.0.0");
    const tmpDir = path.join(root, "tmp");

    const options = withEnv({ TMPDIR: tmpDir }, () =>
      buildPluginLoaderJitiOptions(
        { "openclaw/plugin-sdk": path.join(root, "dist", "plugin-sdk", "root-alias.cjs") },
        { modulePath: path.join(root, "dist", "plugins", "loader.js") },
      ),
    );

    expect(options.fsCache).toContain(path.join(tmpDir, "jiti", "openclaw", "2.0.0"));
  });

  it("pre-normalizes and marks alias maps for source transforms", () => {
    const marker = Symbol.for("pathe:normalizedAlias");
    const aliasMap = {
      "openclaw/plugin-sdk/core": "/repo/src/plugin-sdk/core.ts",
      "openclaw/plugin-sdk": "/repo/src/plugin-sdk/root-alias.cjs",
      "@openclaw/plugin-sdk": "/repo/src/plugin-sdk/root-alias.cjs",
    };

    const first = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;
    const second = buildPluginLoaderJitiOptions({ ...aliasMap }).alias as Record<string, string>;

    expect(second).toBe(first);
    expect((first as Record<symbol, unknown>)[marker]).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(first, marker)).toBe(false);
  });

  it("applies source-transform alias-target normalization before caching", () => {
    const aliasMap = {
      alpha: "/repo/alpha",
      beta: "alpha/sub",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias).not.toBe(aliasMap);
    expect(alias.beta).toBe("/repo/alpha/sub");
  });

  it("follows chained source-transform alias targets", () => {
    const aliasMap = {
      alpha: "/repo/alpha",
      gamma: "beta/gamma",
      beta: "alpha/beta",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.gamma).toBe("/repo/alpha/beta/gamma");
  });

  it("does not rewrite concrete Windows drive alias targets", () => {
    const aliasMap = {
      "C:": "/wrong",
      beta: "C:/repo/beta",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.beta).toBe("C:/repo/beta");
  });

  it("stops chained source-transform alias rewrites after reaching a Windows drive target", () => {
    const aliasMap = {
      beta: "C:/repo/beta",
      "C:": "/wrong",
      alpha: "beta/alpha",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.alpha).toBe("C:/repo/beta/alpha");
  });

  it("bounds cyclic source-transform alias targets", () => {
    const aliasMap = {
      alpha: "beta/a",
      beta: "alpha/b",
      gamma: "alpha/g",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(expectDefined(alias.gamma, "alias.gamma test invariant").length).toBeLessThan(32);
  });

  it("does not attach an empty alias map", () => {
    expect(buildPluginLoaderJitiOptions({})).not.toHaveProperty("alias");
  });
});
