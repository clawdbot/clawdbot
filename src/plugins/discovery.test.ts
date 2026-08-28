// Covers plugin discovery from manifests, installs, and config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import * as pluginHardlinkPolicy from "./hardlink-policy.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import type { PackageManifest } from "./manifest.js";
import { resolvePackageSetupSource } from "./package-entry-resolution.js";
import { listBuiltRuntimeEntryCandidates } from "./package-entrypoints.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

vi.mock("./bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugins", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function withOpenClawPackageArgv<T>(packageRoot: string, fn: () => T): T {
  mkdirSafe(path.join(packageRoot, "bin"));
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}\n', "utf-8");
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "node", path.join(packageRoot, "bin", "openclaw")];
  try {
    return fn();
  } finally {
    process.argv = originalArgv;
  }
}

function symlinkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

const canCreateDirectorySymlinks = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-probe-"));
  const targetDir = path.join(probeDir, "target");
  const linkDir = path.join(probeDir, "link");
  try {
    fs.mkdirSync(targetDir);
    symlinkDirectory(targetDir, linkDir);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

function normalizePathForAssertion(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return value.replace(/\\/g, "/");
}

function hasDiagnosticSourceSuffix(
  diagnostics: Array<{ source?: string }>,
  suffix: string,
): boolean {
  const normalizedSuffix = normalizePathForAssertion(suffix);
  return diagnostics.some((entry) =>
    normalizePathForAssertion(entry.source)?.endsWith(normalizedSuffix ?? suffix),
  );
}

function buildDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(stateDir, "empty-bundled-plugins");
  mkdirSafe(bundledPluginsDir);
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_HOME: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
  };
}

function buildDiscoveryEnvWithOverrides(
  stateDir: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const enablesBundledOverride =
    Object.hasOwn(overrides, "OPENCLAW_BUNDLED_PLUGINS_DIR") &&
    overrides.OPENCLAW_BUNDLED_PLUGINS_DIR !== undefined;
  return {
    ...buildDiscoveryEnv(stateDir),
    ...(enablesBundledOverride ? { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined } : {}),
    ...overrides,
  };
}

function buildBundledDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...buildDiscoveryEnv(stateDir),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  };
}

async function discoverWithStateDir(
  stateDir: string,
  params: Parameters<typeof discoverOpenClawPlugins>[0],
) {
  return discoverOpenClawPlugins({ ...params, env: buildDiscoveryEnv(stateDir) });
}

function discoverWithEnv(params: Parameters<typeof discoverOpenClawPlugins>[0]) {
  return discoverOpenClawPlugins(params);
}

function writePluginPackageManifest(params: {
  packageDir: string;
  packageName: string;
  extensions: string[];
  runtimeExtensions?: string[];
  setupEntry?: string;
  runtimeSetupEntry?: string;
  compatPluginApi?: string;
}) {
  fs.writeFileSync(
    path.join(params.packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      openclaw: {
        extensions: params.extensions,
        ...(params.runtimeExtensions ? { runtimeExtensions: params.runtimeExtensions } : {}),
        ...(params.setupEntry ? { setupEntry: params.setupEntry } : {}),
        ...(params.runtimeSetupEntry ? { runtimeSetupEntry: params.runtimeSetupEntry } : {}),
        ...(params.compatPluginApi ? { compat: { pluginApi: params.compatPluginApi } } : {}),
      },
    }),
    "utf-8",
  );
}

function writePluginManifest(params: {
  pluginDir: string;
  id: string;
  requiresPlugins?: string[];
}) {
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      ...(params.requiresPlugins ? { requiresPlugins: params.requiresPlugins } : {}),
      configSchema: { type: "object" },
    }),
    "utf-8",
  );
}

function writePluginEntry(filePath: string) {
  fs.writeFileSync(filePath, "export default function () {}", "utf-8");
}

function writeStandalonePlugin(filePath: string, source = "export default function () {}") {
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, source, "utf-8");
}

function mockLinuxMountInfo(mountPoints: readonly string[]) {
  const originalReadFileSync = fs.readFileSync;
  return vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
    if (filePath === "/proc/self/mountinfo") {
      return mountPoints
        .map(
          (mountPoint, index) => `${100 + index} 99 0:${index} / ${mountPoint} rw - tmpfs tmpfs rw`,
        )
        .join("\n");
    }
    return originalReadFileSync(filePath, options as never) as never;
  });
}

function createPackagePlugin(params: {
  packageDir: string;
  packageName: string;
  extensions: string[];
  pluginId?: string;
  compatPluginApi?: string;
}) {
  mkdirSafe(params.packageDir);
  writePluginPackageManifest({
    packageDir: params.packageDir,
    packageName: params.packageName,
    extensions: params.extensions,
    ...(params.compatPluginApi ? { compatPluginApi: params.compatPluginApi } : {}),
  });
  if (params.pluginId) {
    writePluginManifest({ pluginDir: params.packageDir, id: params.pluginId });
  }
}

function createPackagePluginWithEntry(params: {
  packageDir: string;
  packageName: string;
  pluginId?: string;
  entryPath?: string;
  writeBuiltRuntime?: boolean;
  compatPluginApi?: string;
}) {
  const entryPath = params.entryPath ?? "src/index.ts";
  mkdirSafe(path.dirname(path.join(params.packageDir, entryPath)));
  createPackagePlugin({
    packageDir: params.packageDir,
    packageName: params.packageName,
    extensions: [`./${entryPath}`],
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    ...(params.compatPluginApi ? { compatPluginApi: params.compatPluginApi } : {}),
  });
  writePluginEntry(path.join(params.packageDir, entryPath));
  if (params.writeBuiltRuntime ?? listBuiltRuntimeEntryCandidates(entryPath).length > 0) {
    const runtimeEntry = listBuiltRuntimeEntryCandidates(entryPath)[0];
    if (runtimeEntry) {
      const runtimePath = path.join(params.packageDir, runtimeEntry.replace(/^\.\//u, ""));
      mkdirSafe(path.dirname(runtimePath));
      writePluginEntry(runtimePath);
    }
  }
}

function createBundleRoot(bundleDir: string, markerPath: string, manifest?: unknown) {
  mkdirSafe(path.dirname(path.join(bundleDir, markerPath)));
  if (manifest) {
    fs.writeFileSync(path.join(bundleDir, markerPath), JSON.stringify(manifest), "utf-8");
    return;
  }
  mkdirSafe(path.join(bundleDir, markerPath));
}

function expectCandidateIds(
  candidates: Array<{ idHint: string }>,
  params: { includes?: readonly string[]; excludes?: readonly string[] },
) {
  const ids = candidates.map((candidate) => candidate.idHint);
  params.includes?.forEach((includedId) => {
    expect(ids).toContain(includedId);
  });
  params.excludes?.forEach((excludedId) => {
    expect(ids).not.toContain(excludedId);
  });
}

function findCandidateById<T extends { idHint?: string }>(candidates: T[], idHint: string) {
  return candidates.find((candidate) => candidate.idHint === idHint);
}

function requireCandidateById<T extends { idHint?: string }>(candidates: T[], idHint: string): T {
  const candidate = findCandidateById(candidates, idHint);
  if (!candidate) {
    throw new Error(`expected plugin candidate ${idHint}`);
  }
  return candidate;
}

function expectCandidateSource(
  candidates: Array<{ idHint?: string; source?: string }>,
  idHint: string,
  source: string,
) {
  const actualSource = findCandidateById(candidates, idHint)?.source;
  const normalizeSource = (value: string | undefined) =>
    value && fs.existsSync(value) ? fs.realpathSync(value) : value;
  expect(normalizeSource(actualSource)).toBe(normalizeSource(source));
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
    true,
  );
}

function expectEscapesPackageDiagnosticForPlugin(
  diagnostics: Array<{ message: string; pluginId?: string }>,
  pluginId: string,
) {
  expect(
    diagnostics.some(
      (entry) => entry.pluginId === pluginId && entry.message.includes("escapes package directory"),
    ),
  ).toBe(true);
}

function expectDiagnostic(params: {
  diagnostics: Array<{
    level?: string;
    message: string;
    pluginId?: string;
    source?: string;
  }>;
  messageIncludes: string;
  level?: string;
  pluginId?: string;
  source?: string;
}) {
  const matched = params.diagnostics.some(
    (diagnostic) =>
      diagnostic.message.includes(params.messageIncludes) &&
      (params.level === undefined || diagnostic.level === params.level) &&
      (params.pluginId === undefined || diagnostic.pluginId === params.pluginId) &&
      (params.source === undefined || diagnostic.source === params.source),
  );
  expect(matched).toBe(true);
}

function expectNoDiagnostic(params: {
  diagnostics: Array<{
    message: string;
    pluginId?: string;
    source?: string;
  }>;
  messageIncludes: string;
  pluginId?: string;
  source?: string;
}) {
  const matched = params.diagnostics.some(
    (diagnostic) =>
      diagnostic.message.includes(params.messageIncludes) &&
      (params.pluginId === undefined || diagnostic.pluginId === params.pluginId) &&
      (params.source === undefined || diagnostic.source === params.source),
  );
  expect(matched).toBe(false);
}

function expectCandidateFields(candidate: object | undefined, expected: Record<string, unknown>) {
  if (!candidate) {
    throw new Error("Expected plugin candidate");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === "installOwner") {
      expect(resolvePluginCandidateInstallOwner(candidate), key).toBe(value);
      continue;
    }
    if (key === "installOwnerAmbiguous") {
      expect(isPluginCandidateInstallOwnerAmbiguous(candidate), key).toBe(value);
      continue;
    }
    expect((candidate as Record<string, unknown>)[key], key).toBe(value);
  }
}

function expectCandidatePresence(
  result: Awaited<ReturnType<typeof discoverOpenClawPlugins>>,
  params: { present?: readonly string[]; absent?: readonly string[] },
) {
  const ids = result.candidates.map((candidate) => candidate.idHint);
  params.present?.forEach((pluginId) => {
    expect(ids).toContain(pluginId);
  });
  params.absent?.forEach((pluginId) => {
    expect(ids).not.toContain(pluginId);
  });
}

function expectCandidateOrder(
  candidates: Array<{ idHint: string }>,
  expectedIds: readonly string[],
) {
  expect(candidates.map((candidate) => candidate.idHint)).toEqual(expectedIds);
}

function expectBundleCandidateMatch(params: {
  candidates: Array<{
    idHint?: string;
    format?: string;
    bundleFormat?: string;
    source?: string;
    rootDir?: string;
  }>;
  idHint: string;
  bundleFormat: string;
  source: string;
  expectRootDir?: boolean;
}) {
  const bundle = requireCandidateById(params.candidates, params.idHint);
  expectCandidateFields(bundle, {
    idHint: params.idHint,
    format: "bundle",
    bundleFormat: params.bundleFormat,
    source: params.source,
  });
  if (params.expectRootDir) {
    expect(normalizePathForAssertion(bundle?.rootDir)).toBe(
      normalizePathForAssertion(fs.realpathSync(params.source)),
    );
  }
}

async function expectRejectedPackageExtensionEntry(params: {
  stateDir: string;
  setup: (stateDir: string) => boolean | void;
  expectedDiagnostic?: "escapes" | "none" | "not_found" | "runtime";
  expectedId?: string;
  expectedDiagnosticPluginId?: string;
}) {
  if (params.setup(params.stateDir) === false) {
    return;
  }
  const result = await discoverWithStateDir(params.stateDir, {});

  if (params.expectedId) {
    expectCandidatePresence(result, { absent: [params.expectedId] });
  } else {
    expect(result.candidates).toHaveLength(0);
  }
  if (params.expectedDiagnostic === "escapes") {
    if (params.expectedDiagnosticPluginId) {
      expectEscapesPackageDiagnosticForPlugin(
        result.diagnostics,
        params.expectedDiagnosticPluginId,
      );
    } else {
      expectEscapesPackageDiagnostic(result.diagnostics);
    }
    return;
  }
  if (params.expectedDiagnostic === "runtime") {
    expect(
      result.diagnostics.some(
        (entry) => entry.level === "warn" && entry.message.includes("compiled runtime output"),
      ),
    ).toBe(true);
    return;
  }
  if (params.expectedDiagnostic === "not_found") {
    expect(
      result.diagnostics.some(
        (entry) => entry.level === "error" && entry.message.includes("extension entry not found"),
      ),
    ).toBe(true);
    return;
  }
  expect(result.diagnostics).toStrictEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("discoverOpenClawPlugins", () => {
  it("discovers global and workspace extensions", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");

    createPackagePluginWithEntry({
      packageDir: path.join(stateDir, "extensions", "alpha"),
      packageName: "@openclaw/alpha",
      pluginId: "alpha",
    });
    createPackagePluginWithEntry({
      packageDir: path.join(workspaceDir, ".openclaw", "extensions", "beta"),
      packageName: "@openclaw/beta",
      pluginId: "beta",
    });

    const { candidates } = await discoverWithStateDir(stateDir, { workspaceDir });
    expectCandidateIds(candidates, { includes: ["alpha", "beta"] });
  });

  it("ignores standalone helper scripts in auto-discovered extension roots", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const globalExt = path.join(stateDir, "extensions");
    const workspaceExt = path.join(workspaceDir, ".openclaw", "extensions");
    mkdirSafe(globalExt);
    mkdirSafe(workspaceExt);
    fs.writeFileSync(path.join(globalExt, "my-helper.mjs"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(workspaceExt, "workspace-helper.js"), "export default {}", "utf-8");

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, { workspaceDir });

    expectCandidateIds(candidates, { excludes: ["my-helper", "workspace-helper"] });
    expect(diagnostics).toStrictEqual([]);
  });

  it("ignores TypeScript declaration files (.d.ts, .d.mts, .d.cts) in extension roots", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);

    fs.writeFileSync(path.join(globalExt, "alpha.d.ts"), "export type Foo = string;", "utf-8");
    fs.writeFileSync(path.join(globalExt, "bravo.d.mts"), "export type Bar = number;", "utf-8");
    fs.writeFileSync(path.join(globalExt, "charlie.d.cts"), "export type Baz = boolean;", "utf-8");
    fs.writeFileSync(path.join(globalExt, "delta.mts"), "export default {};", "utf-8");
    fs.writeFileSync(path.join(globalExt, "echo.cts"), "export default {};", "utf-8");

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {
      workspaceDir,
      extraPaths: [globalExt],
    });

    expectCandidateIds(candidates, {
      includes: ["delta", "echo"],
      excludes: ["alpha.d", "bravo.d", "charlie.d"],
    });
    expect(diagnostics).toStrictEqual([]);
  });

  it("warns without blocking when a plugin requires a missing plugin", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "diffs-language-pack");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/diffs-language-pack",
      pluginId: "diffs-language-pack",
    });
    writePluginManifest({
      pluginDir,
      id: "diffs-language-pack",
      requiresPlugins: ["diffs"],
    });

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { present: ["diffs-language-pack"] });
    expectDiagnostic({
      diagnostics: result.diagnostics,
      level: "warn",
      pluginId: "diffs-language-pack",
      messageIncludes: 'requires plugin "diffs"',
    });
  });

  it("does not warn when a required plugin is discoverable", async () => {
    const stateDir = makeTempDir();
    const extensionsDir = path.join(stateDir, "extensions");
    const languagePackDir = path.join(extensionsDir, "diffs-language-pack");
    createPackagePluginWithEntry({
      packageDir: languagePackDir,
      packageName: "@openclaw/diffs-language-pack",
      pluginId: "diffs-language-pack",
    });
    writePluginManifest({
      pluginDir: languagePackDir,
      id: "diffs-language-pack",
      requiresPlugins: ["diffs"],
    });
    createPackagePluginWithEntry({
      packageDir: path.join(extensionsDir, "diffs"),
      packageName: "@openclaw/diffs",
      pluginId: "diffs",
    });

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { present: ["diffs-language-pack", "diffs"] });
    expectNoDiagnostic({
      diagnostics: result.diagnostics,
      pluginId: "diffs-language-pack",
      messageIncludes: 'requires plugin "diffs"',
    });
  });

  it("recognizes the validated manifest id of an explicitly configured plugin file", async () => {
    const stateDir = makeTempDir();
    const coreDir = path.join(stateDir, "configured-plugins", "acme-core");
    const coreEntry = path.join(coreDir, "index.ts");
    mkdirSafe(coreDir);
    writePluginManifest({ pluginDir: coreDir, id: "acme-core" });
    writePluginEntry(coreEntry);

    const dependentDir = path.join(stateDir, "extensions", "acme-addon");
    createPackagePluginWithEntry({
      packageDir: dependentDir,
      packageName: "@acme/acme-addon",
      pluginId: "acme-addon",
    });
    writePluginManifest({
      pluginDir: dependentDir,
      id: "acme-addon",
      requiresPlugins: ["acme-core"],
    });

    const result = await discoverWithStateDir(stateDir, { extraPaths: [coreEntry] });

    expectCandidatePresence(result, {
      present: ["index", "acme-addon"],
      absent: ["acme-core"],
    });
    expectNoDiagnostic({
      diagnostics: result.diagnostics,
      pluginId: "acme-addon",
      messageIncludes: 'requires plugin "acme-core"',
    });
  });

  it.skipIf(!canCreateDirectorySymlinks)(
    "discovers symlinked plugin directories in global roots",
    async () => {
      const stateDir = makeTempDir();
      const globalExt = path.join(stateDir, "extensions");
      mkdirSafe(globalExt);

      const linkedPluginDir = path.join(stateDir, "linked-plugin-src");
      createPackagePluginWithEntry({
        packageDir: linkedPluginDir,
        packageName: "@openclaw/linked-plugin",
        pluginId: "linked-plugin",
      });

      symlinkDirectory(linkedPluginDir, path.join(globalExt, "linked-plugin"));

      const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});
      expectCandidateIds(candidates, { includes: ["linked-plugin"] });
      expect(findCandidateById(candidates, "linked-plugin")?.rootDir).toBe(
        fs.realpathSync(linkedPluginDir),
      );
      expect(diagnostics).toStrictEqual([]);
    },
  );

  it.skipIf(!canCreateDirectorySymlinks)(
    "discovers symlinked plugin directories in workspace roots",
    async () => {
      const stateDir = makeTempDir();
      const workspaceDir = path.join(stateDir, "workspace");
      const workspaceExt = path.join(workspaceDir, ".openclaw", "extensions");
      mkdirSafe(workspaceExt);

      const linkedPluginDir = path.join(stateDir, "workspace-linked-plugin-src");
      createPackagePluginWithEntry({
        packageDir: linkedPluginDir,
        packageName: "@openclaw/workspace-linked-plugin",
        pluginId: "workspace-linked-plugin",
      });

      symlinkDirectory(linkedPluginDir, path.join(workspaceExt, "workspace-linked-plugin"));

      const { candidates, diagnostics } = await discoverWithStateDir(stateDir, { workspaceDir });
      expectCandidateIds(candidates, { includes: ["workspace-linked-plugin"] });
      expect(findCandidateById(candidates, "workspace-linked-plugin")?.rootDir).toBe(
        fs.realpathSync(linkedPluginDir),
      );
      expect(diagnostics).toStrictEqual([]);
    },
  );

  it.skipIf(process.platform === "win32" || !canCreateDirectorySymlinks)(
    "ignores broken symlinked plugin directories in scanned roots",
    async () => {
      const stateDir = makeTempDir();
      const globalExt = path.join(stateDir, "extensions");
      mkdirSafe(globalExt);

      symlinkDirectory(path.join(stateDir, "missing-plugin-src"), path.join(globalExt, "missing"));

      const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});
      expectCandidateIds(candidates, { excludes: ["missing"] });
      expect(diagnostics).toStrictEqual([]);
    },
  );

  it("does not recurse arbitrary workspace directories for plugin auto-discovery", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceExt = path.join(workspaceDir, ".openclaw", "extensions");

    const expectedWorkspacePluginDir = path.join(workspaceExt, "workspace-plugin");
    createPackagePluginWithEntry({
      packageDir: expectedWorkspacePluginDir,
      packageName: "@openclaw/workspace-plugin",
      pluginId: "workspace-plugin",
    });

    const unrelatedWorkspaceDir = path.join(workspaceDir, "lobster-integrations", "bin");
    createPackagePluginWithEntry({
      packageDir: unrelatedWorkspaceDir,
      packageName: "@openclaw/stray-workspace-plugin",
    });

    const result = discoverOpenClawPlugins({
      workspaceDir,
      env: buildDiscoveryEnv(stateDir),
    });

    expectCandidatePresence(result, {
      present: ["workspace-plugin"],
      absent: ["stray-workspace-plugin"],
    });
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("resolves tilde workspace dirs against the provided env", () => {
    const stateDir = makeTempDir();
    const homeDir = makeTempDir();
    const workspaceRoot = path.join(homeDir, "workspace");
    createPackagePluginWithEntry({
      packageDir: path.join(workspaceRoot, ".openclaw", "extensions", "tilde-workspace"),
      packageName: "@openclaw/tilde-workspace",
      pluginId: "tilde-workspace",
    });

    const result = discoverOpenClawPlugins({
      workspaceDir: "~/workspace",
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeDir,
      },
    });

    expectCandidatePresence(result, { present: ["tilde-workspace"] });
  });

  it("ignores backup and disabled plugin directories in scanned roots", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);

    const backupDir = path.join(globalExt, "feishu.backup-20260222");
    mkdirSafe(backupDir);
    fs.writeFileSync(path.join(backupDir, "index.ts"), "export default function () {}", "utf-8");

    const disabledDir = path.join(globalExt, "telegram.disabled.20260222");
    mkdirSafe(disabledDir);
    fs.writeFileSync(path.join(disabledDir, "index.ts"), "export default function () {}", "utf-8");

    const bakDir = path.join(globalExt, "discord.bak");
    mkdirSafe(bakDir);
    fs.writeFileSync(path.join(bakDir, "index.ts"), "export default function () {}", "utf-8");

    const liveDir = path.join(globalExt, "live");
    mkdirSafe(liveDir);
    fs.writeFileSync(path.join(liveDir, "index.ts"), "export default function () {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, {});
    expectCandidateIds(candidates, {
      includes: ["live"],
      excludes: ["feishu.backup-20260222", "telegram.disabled.20260222", "discord.bak"],
    });
  });

  it("does not warn about source checkout deps when bundled plugins are disabled", () => {
    const stateDir = makeTempDir();
    const packageRoot = makeTempDir();
    mkdirSafe(path.join(packageRoot, "src"));
    const extensionDir = path.join(packageRoot, "extensions", "twitch");
    mkdirSafe(extensionDir);
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf-8");
    fs.writeFileSync(
      path.join(packageRoot, "pnpm-workspace.yaml"),
      "packages:\n  - .\n  - extensions/*\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      '{"name":"@openclaw/twitch"}\n',
      "utf-8",
    );
    fs.writeFileSync(path.join(extensionDir, "openclaw.plugin.json"), '{"id":"twitch"}\n', "utf-8");

    const result = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({ env: buildDiscoveryEnv(stateDir) }),
    );

    expect(result.diagnostics.map((entry) => entry.message).join("\n")).not.toContain(
      "pnpm install",
    );
  });

  it("does not treat repo-level live or test files as plugin entrypoints", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    mkdirSafe(bundledDir);

    writeStandalonePlugin(
      path.join(bundledDir, "video-generation-providers.live.test.ts"),
      "export default {}",
    );
    writeStandalonePlugin(
      path.join(bundledDir, "music-generation-providers.live.test.ts"),
      "export default {}",
    );
    createPackagePluginWithEntry({
      packageDir: path.join(bundledDir, "real-plugin"),
      packageName: "@openclaw/real-plugin",
      pluginId: "real-plugin",
    });

    const { candidates, diagnostics } = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({
        env: {
          ...buildDiscoveryEnv(stateDir),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        },
      }),
    );

    expectCandidateOrder(candidates, ["real-plugin"]);
    expect(diagnostics).toStrictEqual([]);
  });

  it("discovers bind-mounted bundled source overlays before packaged dist bundles", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const bundledPluginDir = path.join(bundledRoot, "synology-chat");
    const sourcePluginDir = path.join(packageRoot, "extensions", "synology-chat");
    createPackagePluginWithEntry({
      packageDir: bundledPluginDir,
      packageName: "@openclaw/synology-chat",
      pluginId: "synology-chat",
      entryPath: "index.js",
    });
    createPackagePluginWithEntry({
      packageDir: sourcePluginDir,
      packageName: "@openclaw/synology-chat",
      pluginId: "synology-chat",
    });
    mockLinuxMountInfo([sourcePluginDir]);
    const sourceEntryPath = path.join(sourcePluginDir, "src", "index.ts");
    const bundledEntryPath = path.join(bundledPluginDir, "index.js");

    const { candidates, diagnostics } = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({
        env: {
          ...buildDiscoveryEnv(stateDir),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        },
      }),
    );

    const synologyCandidates = candidates.filter(
      (candidate) => candidate.idHint === "synology-chat",
    );
    expect(synologyCandidates).toHaveLength(2);
    expectCandidateFields(synologyCandidates[0], {
      origin: "bundled",
      rootDir: fs.realpathSync(sourcePluginDir),
      source: fs.realpathSync(sourceEntryPath),
    });
    expectCandidateFields(synologyCandidates[1], {
      origin: "bundled",
      rootDir: fs.realpathSync(bundledPluginDir),
      source: fs.realpathSync(bundledEntryPath),
    });
    expect(diagnostics).toHaveLength(1);
    expectDiagnostic({
      diagnostics,
      level: "warn",
      source: sourcePluginDir,
      messageIncludes: "bind-mounted bundled plugin source overlay",
    });
  });

  it("keeps copied source plugin dirs inert when they are not mounted overlays", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const bundledPluginDir = path.join(bundledRoot, "synology-chat");
    const sourcePluginDir = path.join(packageRoot, "extensions", "synology-chat");
    createPackagePluginWithEntry({
      packageDir: bundledPluginDir,
      packageName: "@openclaw/synology-chat",
      pluginId: "synology-chat",
      entryPath: "index.js",
    });
    createPackagePluginWithEntry({
      packageDir: sourcePluginDir,
      packageName: "@openclaw/synology-chat",
      pluginId: "synology-chat",
    });
    mockLinuxMountInfo([]);
    const bundledEntryPath = path.join(bundledPluginDir, "index.js");

    const { candidates, diagnostics } = withOpenClawPackageArgv(packageRoot, () =>
      discoverOpenClawPlugins({
        env: {
          ...buildDiscoveryEnv(stateDir),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        },
      }),
    );

    expectCandidateFields(findCandidateById(candidates, "synology-chat"), {
      origin: "bundled",
      rootDir: fs.realpathSync(bundledPluginDir),
      source: fs.realpathSync(bundledEntryPath),
    });
    expect(countMatching(candidates, (candidate) => candidate.idHint === "synology-chat")).toBe(1);
    expect(diagnostics).toStrictEqual([]);
  });

  it("loads package extension packs", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    mkdirSafe(path.join(globalExt, "src"));
    mkdirSafe(path.join(globalExt, "dist"));

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
    });
    writePluginManifest({ pluginDir: globalExt, id: "pack" });
    writePluginEntry(path.join(globalExt, "src", "one.ts"));
    writePluginEntry(path.join(globalExt, "src", "two.ts"));
    writePluginEntry(path.join(globalExt, "dist", "one.js"));
    writePluginEntry(path.join(globalExt, "dist", "two.js"));

    const discovery = await discoverWithStateDir(stateDir, {});
    expectCandidateIds(discovery.candidates, { includes: ["pack/one", "pack/two"] });

    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });
    expect(registry.plugins.map((plugin) => plugin.id).toSorted()).toEqual([
      "pack/one",
      "pack/two",
    ]);
  });

  it("rejects pack entries whose basenames collide on the same derived id", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    mkdirSafe(path.join(globalExt, "src", "a"));
    mkdirSafe(path.join(globalExt, "src", "b"));
    mkdirSafe(path.join(globalExt, "dist", "a"));
    mkdirSafe(path.join(globalExt, "dist", "b"));

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "pack",
      extensions: ["./src/a/index.ts", "./src/b/index.ts"],
    });
    writePluginManifest({ pluginDir: globalExt, id: "pack" });
    writePluginEntry(path.join(globalExt, "src", "a", "index.ts"));
    writePluginEntry(path.join(globalExt, "src", "b", "index.ts"));
    writePluginEntry(path.join(globalExt, "dist", "a", "index.js"));
    writePluginEntry(path.join(globalExt, "dist", "b", "index.js"));

    const discovery = await discoverWithStateDir(stateDir, {});
    // Neither colliding entry may silently win the shared id.
    expect(discovery.candidates.filter((c) => c.idHint === "pack/index")).toHaveLength(0);
    const collision = discovery.diagnostics.find((diag) =>
      diag.message.includes('collide on derived id "pack/index"'),
    );
    expect(collision?.level).toBe("error");
  });

  it("discovers untracked global package plugins that point at TypeScript source", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "local-source-pack");
    mkdirSafe(pluginDir);

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/local-source-pack",
      extensions: ["./index.ts"],
    });
    writePluginManifest({ pluginDir, id: "local-source-pack" });
    writePluginEntry(path.join(pluginDir, "index.ts"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidateSource(
      result.candidates,
      "local-source-pack",
      fs.realpathSync(path.join(pluginDir, "index.ts")),
    );
    expectNoDiagnostic({
      diagnostics: result.diagnostics,
      pluginId: "local-source-pack",
      messageIncludes: "requires compiled runtime output",
    });
  });

  it("allows linked local install records to point at TypeScript source entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "linked-source-pack");
    mkdirSafe(path.join(pluginDir, "src"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/linked-source-pack",
      extensions: ["./src/index.ts"],
      setupEntry: "./src/setup-entry.ts",
    });
    writePluginManifest({ pluginDir, id: "linked-source-pack" });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));

    const installRecords = {
      "linked-source-pack": {
        source: "path",
        installPath: pluginDir,
        sourcePath: pluginDir,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const result = await discoverWithStateDir(stateDir, { installRecords });

    expectCandidateSource(
      result.candidates,
      "linked-source-pack",
      fs.realpathSync(path.join(pluginDir, "src", "index.ts")),
    );
    expectCandidateFields(requireCandidateById(result.candidates, "linked-source-pack"), {
      setupSource: fs.realpathSync(path.join(pluginDir, "src", "setup-entry.ts")),
      installOwner: "linked-source-pack",
    });
    expectNoDiagnostic({
      diagnostics: result.diagnostics,
      pluginId: "linked-source-pack",
      messageIncludes: "requires compiled runtime output",
    });

    const configured = await discoverWithStateDir(stateDir, {
      extraPaths: [pluginDir],
      installRecords,
    });
    expectCandidateFields(requireCandidateById(configured.candidates, "linked-source-pack"), {
      origin: "config",
      installOwner: "linked-source-pack",
    });

    const ambiguous = await discoverWithStateDir(stateDir, {
      installRecords: {
        ...installRecords,
        "other-owner": installRecords["linked-source-pack"],
      },
    });
    const ambiguousCandidate = requireCandidateById(ambiguous.candidates, "linked-source-pack");
    expect(resolvePluginCandidateInstallOwner(ambiguousCandidate)).toBeUndefined();
    expect(isPluginCandidateInstallOwnerAmbiguous(ambiguousCandidate)).toBe(true);
    expect(
      ambiguous.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("multiple plugin install records claim the same package path"),
      ),
    ).toBe(true);
  });

  it.runIf(canCreateDirectorySymlinks)(
    "fails closed when aliased install paths claim the same package",
    async () => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "aliased-pack");
      const aliasDir = path.join(stateDir, "aliased-pack-link");
      mkdirSafe(pluginDir);
      writePluginPackageManifest({
        packageDir: pluginDir,
        packageName: "@openclaw/aliased-pack",
        extensions: ["./index.ts"],
      });
      writePluginManifest({ pluginDir, id: "aliased-pack" });
      writePluginEntry(path.join(pluginDir, "index.ts"));
      symlinkDirectory(pluginDir, aliasDir);

      const result = await discoverWithStateDir(stateDir, {
        installRecords: {
          "owner-one": { source: "path", sourcePath: pluginDir, installPath: pluginDir },
          "owner-two": { source: "path", sourcePath: aliasDir, installPath: aliasDir },
        },
      });

      const candidate = requireCandidateById(result.candidates, "aliased-pack");
      expect(resolvePluginCandidateInstallOwner(candidate)).toBeUndefined();
      expect(isPluginCandidateInstallOwnerAmbiguous(candidate)).toBe(true);
      expect(
        result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes(
            "multiple plugin install records claim the same package path",
          ),
        ),
      ).toBe(true);
    },
  );

  it.runIf(canCreateDirectorySymlinks)(
    "keeps configured-path precedence while inheriting one physical package owner",
    async () => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "configured-alias-pack");
      const aliasDir = path.join(stateDir, "configured-alias-pack-link");
      mkdirSafe(pluginDir);
      writePluginPackageManifest({
        packageDir: pluginDir,
        packageName: "@openclaw/configured-alias-pack",
        extensions: ["./one.ts", "./two.ts"],
      });
      writePluginManifest({ pluginDir, id: "configured-alias-pack" });
      writePluginEntry(path.join(pluginDir, "one.ts"));
      writePluginEntry(path.join(pluginDir, "two.ts"));
      symlinkDirectory(pluginDir, aliasDir);

      const result = await discoverWithStateDir(stateDir, {
        extraPaths: [aliasDir],
        installRecords: {
          "configured-alias-pack": {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
          },
        },
      });

      for (const pluginId of ["configured-alias-pack/one", "configured-alias-pack/two"]) {
        expectCandidateFields(requireCandidateById(result.candidates, pluginId), {
          origin: "config",
          installOwner: "configured-alias-pack",
        });
      }
    },
  );

  it.runIf(process.platform !== "win32" && canCreateDirectorySymlinks)(
    "still scans sibling package entries beside a duplicate installed file alias",
    () => {
      const stateDir = makeTempDir();
      const firstDir = path.join(stateDir, "extensions", "first");
      const secondDir = path.join(stateDir, "extensions", "second");
      const installedFile = path.join(firstDir, "index.js");
      const aliasedFile = path.join(secondDir, "alias.js");
      mkdirSafe(firstDir);
      writePluginEntry(installedFile);
      createPackagePluginWithEntry({
        packageDir: secondDir,
        packageName: "second",
        pluginId: "second",
        entryPath: "other.js",
      });
      fs.symlinkSync(installedFile, aliasedFile);
      const result = discoverOpenClawPlugins({
        env: buildDiscoveryEnv(stateDir),
        installRecords: {
          first: { source: "npm", installPath: installedFile },
          alias: { source: "npm", installPath: aliasedFile },
        },
      });
      expect(result.candidates.map((candidate) => candidate.idHint)).toEqual(["index", "second"]);
      expect(isPluginCandidateInstallOwnerAmbiguous(result.candidates[0]!)).toBe(true);
      expectDiagnostic({
        diagnostics: result.diagnostics,
        messageIncludes: "multiple plugin install records claim the same package path",
      });
    },
  );

  it.runIf(canCreateDirectorySymlinks).each([
    { name: "official registry", overrides: {}, ambiguous: false, trusted: true },
    {
      name: "local archive",
      overrides: { sourcePath: "/tmp/diffs.tgz", artifactKind: "npm-pack", artifactFormat: "tgz" },
      ambiguous: false,
      trusted: undefined,
    },
    { name: "conflicting owners", overrides: {}, ambiguous: true, trusted: undefined },
  ] satisfies Array<{
    name: string;
    overrides: Partial<PluginInstallRecord>;
    ambiguous: boolean;
    trusted: true | undefined;
  }>)("preserves $name trust through configured aliases and bundled ownership", (scenario) => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "diffs");
    const aliasDir = path.join(stateDir, "diffs-link");
    mkdirSafe(pluginDir);
    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/diffs",
      extensions: ["./two.js", "./one.js"],
    });
    writePluginManifest({ pluginDir, id: "diffs" });
    for (const entry of ["two.js", "one.js"]) {
      fs.writeFileSync(
        path.join(pluginDir, entry),
        'throw new Error("must not evaluate metadata")',
      );
    }
    symlinkDirectory(pluginDir, aliasDir);
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/diffs",
      resolvedName: "@openclaw/diffs",
      resolvedSpec: "@openclaw/diffs@2026.7.16",
      installPath: pluginDir,
      ...scenario.overrides,
    };
    const installRecords = {
      diffs: record,
      ...(scenario.ambiguous ? { other: { ...record, installPath: aliasDir } } : {}),
    };
    const extraPaths = [aliasDir, pluginDir];
    const result = discoverOpenClawPlugins({ env, extraPaths, installRecords });
    expect(
      result.candidates.map((candidate) => ({
        id: candidate.idHint,
        source: candidate.source,
        origin: candidate.origin,
        owner: resolvePluginCandidateInstallOwner(candidate),
        ambiguous: isPluginCandidateInstallOwnerAmbiguous(candidate),
      })),
    ).toEqual(
      ["two", "one"].map((entry) => ({
        id: `diffs/${entry}`,
        source: fs.realpathSync(path.join(pluginDir, `${entry}.js`)),
        origin: "config",
        owner: scenario.ambiguous ? undefined : "diffs",
        ambiguous: scenario.ambiguous,
      })),
    );
    const registry = loadPluginManifestRegistryCore({ discovery: result, installRecords, env });
    expect(
      registry.plugins.map((plugin) => ({
        id: plugin.id,
        owner: resolvePluginManifestInstallOwner(plugin),
        trusted: plugin.trustedOfficialInstall,
      })),
    ).toEqual(
      ["two", "one"].map((entry) => ({
        id: `diffs/${entry}`,
        owner: scenario.ambiguous ? undefined : "diffs",
        trusted: scenario.trusted,
      })),
    );
    expect(result.diagnostics).toEqual(
      scenario.ambiguous
        ? [
            {
              level: "error",
              source: aliasDir,
              message:
                "multiple plugin install records claim the same package path; refresh or reinstall the package before using managed lifecycle actions",
            },
          ]
        : [],
    );
  });

  it.runIf(canCreateDirectorySymlinks)(
    "leaves explicit-only file aliases and diagnostics unfinalized",
    () => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "plugin");
      const aliasDir = path.join(stateDir, "alias");
      mkdirSafe(pluginDir);
      writePluginManifest({ pluginDir, id: "plugin", requiresPlugins: ["missing"] });
      writePluginEntry(path.join(pluginDir, "index.js"));
      symlinkDirectory(pluginDir, aliasDir);
      const missing = path.join(stateDir, "missing.js");
      const loadPaths = [
        path.join(aliasDir, "index.js"),
        path.join(pluginDir, "index.js"),
        missing,
        missing,
      ];
      const env = buildDiscoveryEnv(stateDir);
      const raw = discoverConfiguredPluginLoadPaths({ env, loadPaths });
      expect(raw.candidates.map((candidate) => candidate.source)).toEqual(loadPaths.slice(0, 2));
      expect(raw.diagnostics).toEqual(
        [missing, missing].map((source) => ({
          level: "error",
          source,
          message: `plugin path not found: ${source}`,
        })),
      );
      const registry = loadPluginManifestRegistryCore({ discovery: raw, installRecords: {}, env });
      expect(registry.plugins).toHaveLength(1);
      expect(discoverOpenClawPlugins({ env, extraPaths: loadPaths }).candidates).toHaveLength(1);
    },
  );

  it("still requires compiled runtime output for tracked installed package plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "source-only-pack");
    mkdirSafe(path.join(pluginDir, "src"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/source-only-pack",
      extensions: ["./src/index.ts"],
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));

    const installRecords = {
      "source-only-pack": {
        source: "path",
        installPath: pluginDir,
      },
    } satisfies Record<string, PluginInstallRecord>;
    const result = await discoverWithStateDir(stateDir, { installRecords });

    expectCandidateIds(result.candidates, { excludes: ["source-only-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "warn" &&
          entry.pluginId === "source-only-pack" &&
          entry.message.includes("requires compiled runtime output") &&
          entry.message.includes("./dist/index.js") &&
          entry.message.includes("plugin packaging issue") &&
          entry.message.includes("disable/uninstall the plugin"),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.pluginId === "source-only-pack" && entry.message.includes("openclaw doctor --fix"),
      ),
    ).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
  });

  it.each([true, false])(
    "treats sourcePath as managed with preferred install present=%s",
    async (installed) => {
      const stateDir = makeTempDir();
      const sourceDir = path.join(stateDir, "extensions", "source-path-pack");
      const installDir = path.join(stateDir, "installed", "source-path-pack");
      mkdirSafe(path.join(sourceDir, "src"));
      if (installed) {
        mkdirSafe(installDir);
      }

      writePluginPackageManifest({
        packageDir: sourceDir,
        packageName: "@openclaw/source-path-pack",
        extensions: ["./src/index.ts"],
      });
      writePluginEntry(path.join(sourceDir, "src", "index.ts"));

      const installRecords = {
        "source-path-pack": {
          source: "path",
          installPath: installDir,
          sourcePath: sourceDir,
        },
      } satisfies Record<string, PluginInstallRecord>;
      const result = await discoverWithStateDir(stateDir, { installRecords });

      expectCandidateIds(result.candidates, { excludes: ["source-path-pack"] });
      expectDiagnostic({
        diagnostics: result.diagnostics,
        level: "warn",
        pluginId: "source-path-pack",
        messageIncludes: "requires compiled runtime output",
        source: sourceDir,
      });
      expect(result.diagnostics).toHaveLength(1);
    },
  );

  it.skipIf(!canCreateDirectorySymlinks)(
    "treats symlinked install record sourcePath dirs as managed during global scans",
    async () => {
      const stateDir = makeTempDir();
      const globalExt = path.join(stateDir, "extensions");
      const actualSourceDir = path.join(stateDir, "source-checkouts", "source-path-symlink-pack");
      const linkedSourceDir = path.join(globalExt, "source-path-symlink-pack");
      const installDir = path.join(stateDir, "installed", "source-path-symlink-pack");
      mkdirSafe(globalExt);
      mkdirSafe(path.join(actualSourceDir, "src"));
      mkdirSafe(installDir);

      writePluginPackageManifest({
        packageDir: actualSourceDir,
        packageName: "@openclaw/source-path-symlink-pack",
        extensions: ["./src/index.ts"],
      });
      writePluginEntry(path.join(actualSourceDir, "src", "index.ts"));
      symlinkDirectory(actualSourceDir, linkedSourceDir);

      const installRecords = {
        "source-path-symlink-pack": {
          source: "path",
          installPath: installDir,
          sourcePath: linkedSourceDir,
        },
      } satisfies Record<string, PluginInstallRecord>;
      const result = await discoverWithStateDir(stateDir, { installRecords });

      expectCandidateIds(result.candidates, { excludes: ["source-path-symlink-pack"] });
      expectDiagnostic({
        diagnostics: result.diagnostics,
        level: "warn",
        pluginId: "source-path-symlink-pack",
        messageIncludes: "requires compiled runtime output",
        source: linkedSourceDir,
      });
      expect(result.diagnostics).toHaveLength(1);
    },
  );

  it("discovers global plugin directories with package metadata but no package entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "metadata-only-pack");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/metadata-only-pack", version: "0.0.1" }),
      "utf-8",
    );
    writePluginManifest({ pluginDir, id: "metadata-only-pack" });
    writePluginEntry(path.join(pluginDir, "index.ts"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidateSource(
      result.candidates,
      "metadata-only-pack",
      fs.realpathSync(path.join(pluginDir, "index.ts")),
    );
  });

  it("warns on legacy npm declaration stubs without loading workspace node_modules", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "guardrail-bridge");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.extension.json"),
      JSON.stringify({
        name: "guardrail-bridge",
        type: "npm",
        npmSpec: "@guardrail-bridge/guardrail-bridge@1.0.0",
      }),
      "utf-8",
    );

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidateIds(result.candidates, { excludes: ["guardrail-bridge"] });
    expectDiagnostic({
      diagnostics: result.diagnostics,
      level: "warn",
      pluginId: "guardrail-bridge",
      source: path.join(pluginDir, "openclaw.extension.json"),
      messageIncludes: 'run "openclaw doctor --fix"',
    });
  });

  it("keeps explicit runtime extension entries strict for untracked global packages", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "missing-runtime-pack");
    mkdirSafe(pluginDir);

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/missing-runtime-pack",
      extensions: ["./index.ts"],
      runtimeExtensions: ["./dist/index.js"],
    });
    writePluginManifest({ pluginDir, id: "missing-runtime-pack" });
    writePluginEntry(path.join(pluginDir, "index.ts"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidateIds(result.candidates, { excludes: ["missing-runtime-pack"] });
    expectDiagnostic({
      diagnostics: result.diagnostics,
      level: "error",
      source: pluginDir,
      messageIncludes: "runtime extension entry not found: ./dist/index.js",
    });
  });

  it("lets a valid bundled plugin win when a managed package is source-only TypeScript", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const bundledPluginDir = path.join(bundledDir, "discord");
    const installedPluginDir = path.join(stateDir, "extensions", "discord");
    mkdirSafe(bundledPluginDir);
    mkdirSafe(path.join(installedPluginDir, "src"));

    writePluginPackageManifest({
      packageDir: bundledPluginDir,
      packageName: "@openclaw/discord",
      extensions: ["./index.js"],
    });
    writePluginManifest({ pluginDir: bundledPluginDir, id: "discord" });
    writePluginEntry(path.join(bundledPluginDir, "index.js"));

    writePluginPackageManifest({
      packageDir: installedPluginDir,
      packageName: "@openclaw/discord",
      extensions: ["./src/index.ts"],
    });
    writePluginManifest({ pluginDir: installedPluginDir, id: "discord" });
    writePluginEntry(path.join(installedPluginDir, "src", "index.ts"));

    const result = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
      installRecords: {
        discord: {
          source: "path",
          installPath: installedPluginDir,
        },
      },
    });

    const discordCandidates = result.candidates.filter(
      (candidate) => candidate.idHint === "discord",
    );
    expect(discordCandidates).toHaveLength(1);
    expectCandidateFields(discordCandidates[0], {
      origin: "bundled",
      source: fs.realpathSync(path.join(bundledPluginDir, "index.js")),
    });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.pluginId === "discord" &&
          entry.message.includes("requires compiled runtime output"),
      ),
    ).toBe(true);
  });

  it("adds managed ownership to bundled candidates deduplicated in the shared scan", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const plainDir = path.join(bundledDir, "plain");
    const packageDir = path.join(bundledDir, "package");
    mkdirSafe(plainDir);
    mkdirSafe(packageDir);
    writePluginManifest({ pluginDir: plainDir, id: "plain" });
    writePluginEntry(path.join(plainDir, "index.js"));
    writePluginPackageManifest({
      packageDir,
      packageName: "@openclaw/package",
      extensions: ["./index.js"],
    });
    writePluginManifest({ pluginDir: packageDir, id: "package" });
    writePluginEntry(path.join(packageDir, "index.js"));
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const installRecords = {
      "plain-owner": { source: "path", installPath: plainDir },
      "package-owner": { source: "path", installPath: packageDir },
    } satisfies Record<string, PluginInstallRecord>;

    const result = discoverOpenClawPlugins({ env, installRecords });

    expectCandidateSource(result.candidates, "plain", path.join(plainDir, "index.js"));
    expectCandidateFields(requireCandidateById(result.candidates, "plain"), {
      origin: "bundled",
      packageName: undefined,
      installOwner: "plain-owner",
    });
    expectCandidateSource(result.candidates, "package", path.join(packageDir, "index.js"));
    expectCandidateFields(requireCandidateById(result.candidates, "package"), {
      origin: "bundled",
      packageName: "@openclaw/package",
      installOwner: "package-owner",
    });

    const ambiguous = discoverOpenClawPlugins({
      env,
      installRecords: {
        ...installRecords,
        "other-owner": installRecords["plain-owner"],
      },
    });

    expectCandidateFields(requireCandidateById(ambiguous.candidates, "plain"), {
      origin: "bundled",
      installOwner: undefined,
      installOwnerAmbiguous: true,
    });
    expectDiagnostic({
      diagnostics: ambiguous.diagnostics,
      level: "error",
      messageIncludes: "multiple plugin install records claim the same package path",
    });
  });

  it("reuses one filesystem realpath lookup per package root within a discovery run", () => {
    const stateDir = makeTempDir();
    const packageDir = path.join(stateDir, "extensions", "pack");
    mkdirSafe(path.join(packageDir, "src"));
    mkdirSafe(path.join(packageDir, "dist"));

    writePluginPackageManifest({
      packageDir,
      packageName: "pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
    });
    writePluginEntry(path.join(packageDir, "src", "one.ts"));
    writePluginEntry(path.join(packageDir, "src", "two.ts"));
    writePluginEntry(path.join(packageDir, "dist", "one.js"));
    writePluginEntry(path.join(packageDir, "dist", "two.js"));

    const realpathSync = vi.spyOn(fs, "realpathSync");
    const { candidates } = discoverOpenClawPlugins({
      env: buildDiscoveryEnv(stateDir),
    });

    expectCandidateIds(candidates, { includes: ["pack/one", "pack/two"] });
    expect(
      realpathSync.mock.calls.filter(
        ([targetPath]) => path.resolve(String(targetPath)) === path.resolve(packageDir),
      ),
    ).toHaveLength(1);
  });

  it.skipIf(!canCreateDirectorySymlinks)(
    "reuses the canonical realpath cache entry for symlinked package roots",
    () => {
      const stateDir = makeTempDir();
      const realPackageDir = path.join(stateDir, "real-pack");
      mkdirSafe(path.join(realPackageDir, "src"));

      writePluginPackageManifest({
        packageDir: realPackageDir,
        packageName: "pack",
        extensions: ["./src/index.ts"],
      });
      writePluginEntry(path.join(realPackageDir, "src", "index.ts"));

      const linkedPackageDir = path.join(stateDir, "linked-pack");
      symlinkDirectory(realPackageDir, linkedPackageDir);
      const canonicalPackageDir = fs.realpathSync(realPackageDir);

      const realpathSync = vi.spyOn(fs, "realpathSync");
      const { candidates } = discoverOpenClawPlugins({
        extraPaths: [linkedPackageDir, canonicalPackageDir],
        env: buildDiscoveryEnv(stateDir),
      });

      expectCandidateIds(candidates, { includes: ["pack"] });
      expect(
        realpathSync.mock.calls.filter(([targetPath]) => {
          const resolved = path.resolve(String(targetPath));
          return (
            resolved === path.resolve(linkedPackageDir) ||
            resolved === path.resolve(canonicalPackageDir)
          );
        }),
      ).toHaveLength(1);
    },
  );

  it("uses explicit runtime extension entries for installed package plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-pack",
      extensions: ["./src/index.ts"],
      runtimeExtensions: ["./dist/index.js"],
      setupEntry: "./src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));
    writePluginEntry(path.join(pluginDir, "dist", "setup-entry.js"));

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const candidate = findCandidateById(candidates, "runtime-pack");
    expect(fs.realpathSync(candidate?.source ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "index.js")),
    );
    expect(fs.realpathSync(candidate?.setupSource ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "setup-entry.js")),
    );
  });

  it("rejects missing explicit runtime setup entries for installed package plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "missing-runtime-setup-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/missing-runtime-setup-pack",
      extensions: ["./dist/index.js"],
      setupEntry: "./src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));

    const result = await discoverWithStateDir(stateDir, {});
    const candidate = requireCandidateById(result.candidates, "missing-runtime-setup-pack");

    expect(candidate.setupSource).toBeUndefined();
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "missing-runtime-setup-pack" &&
          entry.message.includes("runtime setup entry not found") &&
          entry.message.includes("./dist/setup-entry.js"),
      ),
    ).toBe(true);
  });

  it("keeps package candidate identity distinct from channel-owned setup diagnostics", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "missing-setup-pack");
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/missing-setup-pack",
      extensions: ["./dist/index.js"],
      setupEntry: "./src/setup-entry.ts",
    });
    const packagePath = path.join(pluginDir, "package.json");
    const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    packageManifest.openclaw.channel = { id: "explicit-setup-channel" };
    fs.writeFileSync(packagePath, JSON.stringify(packageManifest), "utf-8");
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));

    const result = await discoverWithStateDir(stateDir, {});
    const candidate = requireCandidateById(result.candidates, "missing-setup-pack");

    expect(candidate.setupSource).toBeUndefined();
    expectDiagnostic({
      diagnostics: result.diagnostics,
      level: "error",
      pluginId: "explicit-setup-channel",
      source: pluginDir,
      messageIncludes: "setup entry not found: src/setup-entry.ts",
    });
  });

  it.each([
    { pluginMetadataId: 42, channelMetadataId: { invalid: true }, runtimeSetup: false },
    { pluginMetadataId: { invalid: true }, channelMetadataId: ["invalid"], runtimeSetup: true },
  ])(
    "keeps malformed setup metadata owners as stable directory strings: %j",
    async ({ pluginMetadataId, channelMetadataId, runtimeSetup }) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "malformed-setup-owner");
      mkdirSafe(path.join(pluginDir, "dist"));
      mkdirSafe(path.join(pluginDir, "src"));
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: 42,
          openclaw: {
            extensions: ["./dist/index.js"],
            setupEntry: "./src/setup-entry.ts",
            ...(runtimeSetup ? { runtimeSetupEntry: "./dist/setup-entry.js" } : {}),
            plugin: { id: pluginMetadataId },
            channel: { id: channelMetadataId },
          },
        }),
        "utf-8",
      );
      writePluginEntry(path.join(pluginDir, "dist", "index.js"));
      if (runtimeSetup) {
        writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));
      }

      const result = await discoverWithStateDir(stateDir, {});

      expectCandidatePresence(result, { present: ["malformed-setup-owner"] });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "malformed-setup-owner",
          message: expect.stringContaining(runtimeSetup ? "runtime setup entry" : "setup entry"),
        }),
      );
    },
  );

  it.each([
    { pluginMetadataId: "plugin-owner", channelMetadataId: "channel-owner", owner: "plugin-owner" },
    { pluginMetadataId: 42, channelMetadataId: "channel-owner", owner: "channel-owner" },
    { pluginMetadataId: { invalid: true }, channelMetadataId: false, owner: undefined },
  ])(
    "normalizes setup owner metadata for callers without a prepared owner: %j",
    ({ pluginMetadataId, channelMetadataId, owner }) => {
      const pluginDir = makeTempDir();
      const diagnostics: ReturnType<typeof discoverOpenClawPlugins>["diagnostics"] = [];
      const manifest = structuredClone({
        openclaw: {
          setupEntry: "./missing-setup.js",
          plugin: { id: pluginMetadataId },
          channel: { id: channelMetadataId },
        },
      });

      expect(
        resolvePackageSetupSource({
          packageDir: pluginDir,
          manifest: manifest as unknown as PackageManifest,
          origin: "global",
          sourceLabel: pluginDir,
          diagnostics,
        }),
      ).toBeNull();
      expect(diagnostics).toEqual([
        expect.objectContaining({
          level: "error",
          ...(owner ? { pluginId: owner } : {}),
        }),
      ]);
      if (!owner) {
        expect(diagnostics[0]).not.toHaveProperty("pluginId");
      }
    },
  );

  it("rejects package runtimeExtensions that do not match extension entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-mismatch-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-mismatch-pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
      runtimeExtensions: ["./dist/one.js"],
    });
    writePluginEntry(path.join(pluginDir, "src", "one.ts"));
    writePluginEntry(path.join(pluginDir, "src", "two.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "one.js"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { absent: ["runtime-mismatch-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("runtimeExtensions length (1)") &&
          entry.message.includes("extensions length (2)"),
      ),
    ).toBe(true);
  });

  it("rejects blank package runtimeExtensions before falling back to inferred entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "runtime-blank-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/runtime-blank-pack",
      extensions: ["./src/index.ts"],
      runtimeExtensions: [" "],
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { absent: ["runtime-blank-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("openclaw.runtimeExtensions[0]") &&
          entry.message.includes("non-empty string"),
      ),
    ).toBe(true);
  });

  it("rejects blank package extensions instead of falling back to inferred entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "extension-blank-pack");
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/extension-blank-pack",
      extensions: ["./dist/index.js", " "],
    });
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));

    const result = await discoverWithStateDir(stateDir, {});

    expectCandidatePresence(result, { absent: ["extension-blank-pack"] });
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.includes("openclaw.extensions[1]") &&
          entry.message.includes("non-empty string"),
      ),
    ).toBe(true);
  });

  it.each([42, false, { invalid: true }, ["invalid"], "@scope/", "/"])(
    "reports invalid package extensions when the package name is malformed: %j",
    async (packageName) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "malformed-package-name");
      mkdirSafe(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({ name: packageName, openclaw: { extensions: [" "] } }),
        "utf-8",
      );

      const result = await discoverWithStateDir(stateDir, {});

      expectCandidatePresence(result, { absent: ["malformed-package-name"] });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "malformed-package-name",
          source: pluginDir,
          message: "package.json openclaw.extensions[0] must be a non-empty string",
        }),
      );
    },
  );

  it("retains every directory owner when nameless invalid packages are deduplicated", async () => {
    const stateDir = makeTempDir();
    for (const [pluginId, packageName] of [
      ["first-nameless", undefined],
      ["second-nameless", 42],
    ] as const) {
      const pluginDir = path.join(stateDir, "extensions", pluginId);
      mkdirSafe(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          ...(packageName === undefined ? {} : { name: packageName }),
          openclaw: { extensions: [" "] },
        }),
        "utf-8",
      );
    }

    const discovery = await discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

    expect(registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "first-nameless" }),
      expect.objectContaining({ level: "error", pluginId: "second-nameless" }),
    ]);
  });

  it("retains directory owners for nameless package candidates with malformed manifests", async () => {
    const stateDir = makeTempDir();
    for (const pluginId of ["first-malformed-manifest", "second-malformed-manifest"]) {
      const pluginDir = path.join(stateDir, "extensions", pluginId);
      mkdirSafe(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({ name: 42, openclaw: { extensions: ["./index.js"] } }),
        "utf-8",
      );
      fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
      writePluginEntry(path.join(pluginDir, "index.js"));
    }

    const discovery = await discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

    expect(discovery.candidates.map((candidate) => candidate.idHint)).toEqual([
      "first-malformed-manifest",
      "second-malformed-manifest",
    ]);
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "first-malformed-manifest" }),
      expect.objectContaining({ level: "error", pluginId: "second-malformed-manifest" }),
    ]);
  });

  it("preserves explicit package plugin owners when their manifests are malformed", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "metadata-owner-root");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/package-name-owner",
        openclaw: { extensions: ["./index.js"], plugin: { id: "metadata-plugin-owner" } },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
    writePluginEntry(path.join(pluginDir, "index.js"));

    const discovery = await discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

    expect(discovery.candidates).toEqual([
      expect.objectContaining({ idHint: "metadata-plugin-owner" }),
    ]);
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "metadata-plugin-owner" }),
    ]);
  });

  it.each([
    { packageName: "@openclaw/package-plugin-owner", candidateId: "package-plugin-owner" },
    { packageName: "@scope/", candidateId: "channel-package-root" },
    { packageName: "/", candidateId: "channel-package-root" },
    { packageName: 42, candidateId: "channel-package-root" },
  ])(
    "preserves channel diagnostic ownership separately from package candidate identity: %j",
    async ({ packageName, candidateId }) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "channel-package-root");
      mkdirSafe(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: packageName,
          openclaw: { extensions: ["./index.js"], channel: { id: "channel-diagnostic-owner" } },
        }),
        "utf-8",
      );
      fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), '{"id":', "utf-8");
      writePluginEntry(path.join(pluginDir, "index.js"));

      const discovery = await discoverWithStateDir(stateDir, {});
      const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });

      expect(discovery.candidates).toEqual([
        expect.objectContaining({
          idHint: candidateId,
          diagnosticIdHint: "channel-diagnostic-owner",
        }),
      ]);
      expect(registry.diagnostics).toEqual([
        expect.objectContaining({ level: "error", pluginId: "channel-diagnostic-owner" }),
      ]);
    },
  );

  it("retains every owner when invalid package extension diagnostics are deduplicated", async () => {
    const stateDir = makeTempDir();
    for (const [packageName, pluginId, explicitOwner] of [
      ["@openclaw/first-blank-pack", "first-blank-pack", undefined],
      ["@openclaw/second-blank-pack", "second-blank-pack", undefined],
      ["@openclaw/example-plugin", "example", undefined],
      ["@openclaw/manifest-derived-package", "manifest-owner", "manifest"],
      ["@openclaw/channel-derived-package", "channel-owner", "channel"],
    ] as const) {
      const pluginDir = path.join(stateDir, "extensions", pluginId);
      mkdirSafe(path.join(pluginDir, "dist"));
      writePluginPackageManifest({
        packageDir: pluginDir,
        packageName,
        extensions: ["./dist/index.js", " "],
      });
      writePluginEntry(path.join(pluginDir, "dist", "index.js"));
      if (explicitOwner === "manifest") {
        writePluginManifest({ pluginDir, id: pluginId });
      }
      if (explicitOwner === "channel") {
        const packagePath = path.join(pluginDir, "package.json");
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
        packageManifest.openclaw.channel = { id: pluginId };
        fs.writeFileSync(packagePath, JSON.stringify(packageManifest), "utf-8");
      }
    }

    const discovery = await discoverWithStateDir(stateDir, {});
    const registry = loadPluginManifestRegistryCore({ discovery, installRecords: {} });
    const errors = registry.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes("openclaw.extensions[1]"),
    );

    expect(errors).toHaveLength(5);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", pluginId: "first-blank-pack" }),
        expect.objectContaining({ level: "error", pluginId: "second-blank-pack" }),
        expect.objectContaining({ level: "error", pluginId: "example" }),
        expect.objectContaining({ level: "error", pluginId: "manifest-owner" }),
        expect.objectContaining({ level: "error", pluginId: "channel-owner" }),
      ]),
    );
  });

  it("infers built dist entries for installed TypeScript package plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "built-peer-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/built-peer-pack",
      extensions: ["src/index.ts"],
      setupEntry: "src/setup-entry.ts",
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.ts"));
    writePluginEntry(path.join(pluginDir, "src", "index.js"));
    writePluginEntry(path.join(pluginDir, "src", "setup-entry.js"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));
    writePluginEntry(path.join(pluginDir, "dist", "setup-entry.js"));

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const candidate = findCandidateById(candidates, "built-peer-pack");
    expect(fs.realpathSync(candidate?.source ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "index.js")),
    );
    expect(fs.realpathSync(candidate?.setupSource ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "setup-entry.js")),
    );
  });

  it("preserves nested entry paths when inferring installed dist entries", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "nested-pack");
    mkdirSafe(path.join(pluginDir, "plugin"));
    mkdirSafe(path.join(pluginDir, "dist", "plugin"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/nested-pack",
      extensions: ["./plugin/index.ts"],
    });
    writePluginEntry(path.join(pluginDir, "plugin", "index.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "plugin", "index.js"));

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const candidate = findCandidateById(candidates, "nested-pack");
    expect(fs.realpathSync(candidate?.source ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "dist", "plugin", "index.js")),
    );
  });

  it("keeps workspace package TypeScript entries unless runtime entries are explicit", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-pack");
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/workspace-pack",
      extensions: ["./src/index.ts"],
    });
    writePluginEntry(path.join(pluginDir, "src", "index.ts"));
    writePluginEntry(path.join(pluginDir, "dist", "index.js"));

    const { candidates } = discoverOpenClawPlugins({
      workspaceDir,
      env: buildDiscoveryEnv(stateDir),
    });
    expect(fs.realpathSync(findCandidateById(candidates, "workspace-pack")?.source ?? "")).toBe(
      fs.realpathSync(path.join(pluginDir, "src", "index.ts")),
    );
  });

  it("skips incompatible non-bundled package plugin API candidates during discovery", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    const pluginDir = path.join(globalExt, "future-channel");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/future-channel",
      pluginId: "future-channel",
      compatPluginApi: ">=2026.5.27-beta.2",
    });

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
      }),
    });

    expectCandidateIds(candidates, { excludes: ["future-channel"] });
    expectDiagnostic({
      diagnostics,
      level: "warn",
      pluginId: "future-channel",
      source: path.join(pluginDir, "package.json"),
      messageIncludes:
        'plugin requires plugin API >=2026.5.27-beta.2, but this host is 2026.5.27-beta.1; skipping discovery (check "openclaw --version", OPENCLAW_COMPATIBILITY_HOST_VERSION, or run "openclaw doctor")',
    });
  });

  it("skips malformed non-bundled package plugin API candidates during discovery", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    const pluginDir = path.join(globalExt, "malformed-channel");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/malformed-channel",
        openclaw: {
          extensions: ["./index.js"],
          plugin: { id: "malformed-channel" },
          compat: { pluginApi: 20260527 },
        },
      }),
      "utf-8",
    );
    writePluginEntry(path.join(pluginDir, "index.js"));

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27",
      }),
    });

    expectCandidateIds(candidates, { excludes: ["malformed-channel"] });
    expectDiagnostic({
      diagnostics,
      level: "warn",
      pluginId: "malformed-channel",
      source: path.join(pluginDir, "package.json"),
      messageIncludes:
        "invalid package plugin API metadata: package.json openclaw.compat.pluginApi must be a string; skipping discovery (check package.json openclaw.compat.pluginApi)",
    });
  });

  it.each([
    {
      name: "manifest owner wins for incompatible API ranges",
      packageName: "@openclaw/package-owner",
      manifestId: "manifest-owner",
      packagePluginId: "package-plugin-owner",
      packageChannelId: "package-channel-owner",
      pluginApi: ">=2026.5.27-beta.2",
      expectedOwner: "manifest-owner",
    },
    {
      name: "channel owner wins for malformed API ranges",
      packageName: "@openclaw/package-owner",
      manifestId: undefined,
      packagePluginId: 42,
      packageChannelId: "package-channel-owner",
      pluginApi: 20260527,
      expectedOwner: "package-channel-owner",
    },
    {
      name: "directory owner handles malformed package and metadata identities",
      packageName: false,
      manifestId: undefined,
      packagePluginId: { invalid: true },
      packageChannelId: ["invalid"],
      pluginApi: 20260527,
      expectedOwner: "compatibility-owner",
    },
  ])(
    "attributes incompatible package API diagnostics to the canonical owner: $name",
    ({ packageName, manifestId, packagePluginId, packageChannelId, pluginApi, expectedOwner }) => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "extensions", "compatibility-owner");
      mkdirSafe(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: packageName,
          openclaw: {
            extensions: [" "],
            plugin: { id: packagePluginId },
            channel: { id: packageChannelId },
            compat: { pluginApi },
          },
        }),
        "utf-8",
      );
      if (manifestId) {
        writePluginManifest({ pluginDir, id: manifestId });
      }

      const result = discoverOpenClawPlugins({
        env: buildDiscoveryEnvWithOverrides(stateDir, {
          OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
        }),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: "warn", pluginId: expectedOwner }),
      );
      expectNoDiagnostic({
        diagnostics: result.diagnostics,
        messageIncludes: "openclaw.extensions",
      });
    },
  );

  it("checks non-bundled package plugin API before package entry validation", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    const pluginDir = path.join(globalExt, "future-shape");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/future-shape",
        openclaw: {
          extensions: { runtime: "./src/index.ts" },
          compat: { pluginApi: ">=2026.5.27-beta.2" },
        },
      }),
      "utf-8",
    );

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
      }),
    });

    expectCandidateIds(candidates, { excludes: ["future-shape"] });
    expectDiagnostic({
      diagnostics,
      level: "warn",
      pluginId: "future-shape",
      source: path.join(pluginDir, "package.json"),
      messageIncludes:
        "plugin requires plugin API >=2026.5.27-beta.2, but this host is 2026.5.27-beta.1; skipping discovery",
    });
    expectNoDiagnostic({ diagnostics, messageIncludes: "openclaw.extensions" });
  });

  it("discovers same-floor beta non-bundled package plugin API candidates", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    createPackagePluginWithEntry({
      packageDir: path.join(globalExt, "current-channel"),
      packageName: "@openclaw/current-channel",
      pluginId: "current-channel",
      compatPluginApi: ">=2026.5.27-beta.1",
    });

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.27-beta.1",
      }),
    });

    expectCandidateIds(candidates, { includes: ["current-channel"] });
    expect(diagnostics).toStrictEqual([]);
  });

  it("discovers present bundled package plugins without package metadata gates", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "downloadable");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/downloadable",
        openclaw: {
          extensions: ["./index.ts"],
          compat: { pluginApi: ">=2099.1.1" },
        },
      }),
      "utf-8",
    );
    writePluginManifest({ pluginDir, id: "downloadable" });
    writePluginEntry(path.join(pluginDir, "index.ts"));

    const { candidates } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
    });

    expectCandidateIds(candidates, { includes: ["downloadable"] });
  });

  it("keeps trusted bundled package fallback from missing TypeScript metadata to JavaScript", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "downloadable");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/downloadable",
        openclaw: {
          extensions: ["./index.ts"],
        },
      }),
      "utf-8",
    );
    writePluginManifest({ pluginDir, id: "downloadable" });
    writePluginEntry(path.join(pluginDir, "index.js"));

    const { candidates, diagnostics } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
    });

    expectCandidateSource(
      candidates,
      "downloadable",
      fs.realpathSync(path.join(pluginDir, "index.js")),
    );
    expect(diagnostics).toStrictEqual([]);
  });

  it("discovers source-checkout-only bundled plugins alongside built bundled plugins", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const sourceDir = path.join(packageRoot, "extensions");
    const builtPluginDir = path.join(bundledDir, "shipped");
    const sourceBuiltPluginDir = path.join(sourceDir, "shipped");
    const sourceOnlyPluginDir = path.join(sourceDir, "downloadable");
    mkdirSafe(path.join(packageRoot, "src"));
    mkdirSafe(builtPluginDir);
    mkdirSafe(sourceBuiltPluginDir);
    mkdirSafe(sourceOnlyPluginDir);
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf-8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");

    writePluginPackageManifest({
      packageDir: builtPluginDir,
      packageName: "@openclaw/shipped",
      extensions: ["./index.js"],
    });
    writePluginManifest({ pluginDir: builtPluginDir, id: "shipped" });
    writePluginEntry(path.join(builtPluginDir, "index.js"));
    writePluginPackageManifest({
      packageDir: sourceBuiltPluginDir,
      packageName: "@openclaw/shipped",
      extensions: ["./index.ts"],
    });
    writePluginManifest({ pluginDir: sourceBuiltPluginDir, id: "shipped" });
    writePluginEntry(path.join(sourceBuiltPluginDir, "index.ts"));
    fs.writeFileSync(
      path.join(sourceOnlyPluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/downloadable",
        openclaw: {
          extensions: ["./index.ts"],
        },
      }),
      "utf-8",
    );
    writePluginManifest({ pluginDir: sourceOnlyPluginDir, id: "downloadable" });
    writePluginEntry(path.join(sourceOnlyPluginDir, "index.ts"));

    const { candidates } = discoverOpenClawPlugins({
      env: buildDiscoveryEnvWithOverrides(stateDir, {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      }),
    });

    expectCandidateIds(candidates, { includes: ["shipped", "downloadable"] });
    expect(fs.realpathSync(findCandidateById(candidates, "shipped")?.source ?? "")).toBe(
      fs.realpathSync(path.join(builtPluginDir, "index.js")),
    );
    expect(fs.realpathSync(findCandidateById(candidates, "downloadable")?.source ?? "")).toBe(
      fs.realpathSync(path.join(sourceOnlyPluginDir, "index.ts")),
    );
  });

  it("does not discover nested node_modules copies under installed plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "opik-openclaw");
    const nestedDiffsDir = path.join(
      pluginDir,
      "node_modules",
      "openclaw",
      "dist",
      "extensions",
      "diffs",
    );
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(path.join(pluginDir, "dist"));
    mkdirSafe(nestedDiffsDir);

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@opik/opik-openclaw",
      extensions: ["./src/index.ts"],
    });
    writePluginManifest({ pluginDir, id: "opik-openclaw" });
    fs.writeFileSync(
      path.join(pluginDir, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "dist", "index.js"),
      "export default function () {}",
      "utf-8",
    );

    writePluginPackageManifest({
      packageDir: path.join(pluginDir, "node_modules", "openclaw"),
      packageName: "openclaw",
      extensions: [`./${bundledDistPluginFile("diffs", "index.js")}`],
    });
    writePluginManifest({ pluginDir: nestedDiffsDir, id: "diffs" });
    fs.writeFileSync(
      path.join(nestedDiffsDir, "index.js"),
      "module.exports = { id: 'diffs', register() {} };",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});
    expectCandidateOrder(candidates, ["opik-openclaw"]);
  });

  it("skips dependency and build directories while scanning workspace roots", () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");
    const workspaceRoot = path.join(workspaceDir, ".openclaw", "extensions");
    const workspacePluginDir = path.join(workspaceRoot, "workspace-plugin");
    const nestedNodeModulesDir = path.join(workspaceRoot, "node_modules", "openclaw");
    const nestedDistDir = path.join(workspaceRoot, "dist", "extensions", "diffs");
    mkdirSafe(path.join(workspacePluginDir, "src"));
    mkdirSafe(path.join(nestedNodeModulesDir, "src"));
    mkdirSafe(nestedDistDir);

    createPackagePluginWithEntry({
      packageDir: workspacePluginDir,
      packageName: "@openclaw/workspace-plugin",
      pluginId: "workspace-plugin",
    });

    createPackagePluginWithEntry({
      packageDir: nestedNodeModulesDir,
      packageName: "openclaw",
      pluginId: "node-modules-copy",
    });

    writePluginManifest({ pluginDir: nestedDistDir, id: "dist-copy" });
    fs.writeFileSync(
      path.join(nestedDistDir, "index.js"),
      "module.exports = { id: 'dist-copy', register() {} };",
      "utf-8",
    );

    const { candidates } = discoverOpenClawPlugins({
      workspaceDir,
      env: buildDiscoveryEnv(stateDir),
    });

    expectCandidateOrder(candidates, ["workspace-plugin"]);
  });

  it.each([
    {
      name: "derives unscoped ids for scoped packages",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "extensions", "voice-call-pack");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@openclaw/voice-call",
          entryPath: "src/index.ts",
        });
        return {};
      },
      includes: ["voice-call"],
    },
    {
      name: "strips provider suffixes from package-derived ids",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "extensions", "local-provider-pack");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@example/local-provider",
          pluginId: "local",
          entryPath: "src/index.ts",
        });
        return {};
      },
      includes: ["local"],
      excludes: ["local-provider"],
    },
    {
      name: "strips plugin suffixes consistently from package-derived ids",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "extensions", "example-plugin-pack");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@example/example-plugin",
          entryPath: "src/index.ts",
        });
        return {};
      },
      includes: ["example"],
      excludes: ["example-plugin"],
    },
    {
      name: "normalizes bundled speech package ids to canonical plugin ids",
      setup: (stateDir: string) => {
        for (const [dirName, packageName, pluginId] of [
          ["elevenlabs-speech-pack", "@openclaw/elevenlabs-speech", "elevenlabs"],
          ["microsoft-speech-pack", "@openclaw/microsoft-speech", "microsoft"],
        ] as const) {
          const packageDir = path.join(stateDir, "extensions", dirName);
          createPackagePluginWithEntry({
            packageDir,
            packageName,
            pluginId,
            entryPath: "src/index.ts",
          });
        }
        return {};
      },
      includes: ["elevenlabs", "microsoft"],
      excludes: ["elevenlabs-speech", "microsoft-speech"],
    },
    {
      name: "treats configured directory paths as plugin packages",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "packs", "demo-plugin-dir");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@openclaw/demo-plugin-dir",
          entryPath: "index.js",
        });
        return { extraPaths: [packageDir] };
      },
      includes: ["demo-plugin-dir"],
    },
  ] as const)("$name", async ({ setup, includes, excludes }) => {
    const stateDir = makeTempDir();
    const discoverParams = setup(stateDir);
    const { candidates } = await discoverWithStateDir(stateDir, discoverParams);
    expectCandidateIds(candidates, { includes, excludes });
  });

  it.each([
    {
      name: "auto-detects Agent Plugins bundles as bundle candidates",
      idHint: "portable-bundle",
      bundleFormat: "agent",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "portable-bundle");
        createBundleRoot(bundleDir, "plugin.json", {
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "portable-bundle",
        });
        mkdirSafe(path.join(bundleDir, "skills", "sample"));
        return bundleDir;
      },
      expectRootDir: true,
    },
    {
      name: "auto-detects Codex bundles as bundle candidates",
      idHint: "sample-bundle",
      bundleFormat: "codex",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "sample-bundle");
        createBundleRoot(bundleDir, ".codex-plugin/plugin.json", {
          name: "Sample Bundle",
          skills: "skills",
        });
        mkdirSafe(path.join(bundleDir, "skills"));
        return bundleDir;
      },
      expectRootDir: true,
    },
    {
      name: "auto-detects manifestless Claude bundles from the default layout",
      idHint: "claude-bundle",
      bundleFormat: "claude",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "claude-bundle");
        mkdirSafe(path.join(bundleDir, "commands"));
        fs.writeFileSync(
          path.join(bundleDir, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
        return bundleDir;
      },
    },
    {
      name: "auto-detects Cursor bundles as bundle candidates",
      idHint: "cursor-bundle",
      bundleFormat: "cursor",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "cursor-bundle");
        createBundleRoot(bundleDir, ".cursor-plugin/plugin.json", {
          name: "Cursor Bundle",
        });
        mkdirSafe(path.join(bundleDir, ".cursor", "commands"));
        return bundleDir;
      },
    },
  ] as const)("$name", async ({ idHint, bundleFormat, setup, expectRootDir }) => {
    const stateDir = makeTempDir();
    const bundleDir = setup(stateDir);
    const { candidates } = await discoverWithStateDir(stateDir, {});

    expectBundleCandidateMatch({
      candidates,
      idHint,
      bundleFormat,
      source: bundleDir,
      expectRootDir,
    });
  });

  it("preserves the package install owner for managed bundle candidates", async () => {
    const stateDir = makeTempDir();
    const bundleDir = path.join(stateDir, "extensions", "package-owner");
    createBundleRoot(bundleDir, ".codex-plugin/plugin.json", {
      name: "runtime-child",
      skills: "skills",
    });
    mkdirSafe(path.join(bundleDir, "skills"));

    const { candidates } = await discoverWithStateDir(stateDir, {
      installRecords: {
        "package-owner": {
          source: "path",
          sourcePath: bundleDir,
          installPath: bundleDir,
        },
      },
    });

    expectCandidateFields(requireCandidateById(candidates, "runtime-child"), {
      installOwner: "package-owner",
    });
  });

  it.each([
    {
      name: "falls back to legacy index discovery when a scanned bundle sidecar is malformed",
      bundleMarker: ".claude-plugin/plugin.json",
      setup: (stateDir: string) => {
        const pluginDir = path.join(stateDir, "extensions", "legacy-with-bad-bundle");
        mkdirSafe(path.dirname(path.join(pluginDir, ".claude-plugin", "plugin.json")));
        fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
        fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "{", "utf-8");
        return {};
      },
    },
    {
      name: "falls back to legacy index discovery for configured paths with malformed bundle sidecars",
      bundleMarker: ".codex-plugin/plugin.json",
      setup: (stateDir: string) => {
        const pluginDir = path.join(stateDir, "plugins", "legacy-with-bad-bundle");
        mkdirSafe(path.dirname(path.join(pluginDir, ".codex-plugin", "plugin.json")));
        fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
        fs.writeFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "{", "utf-8");
        return { extraPaths: [pluginDir] };
      },
    },
  ] as const)("$name", async ({ setup, bundleMarker }) => {
    const stateDir = makeTempDir();
    const result = await discoverWithStateDir(stateDir, setup(stateDir));
    const legacy = findCandidateById(result.candidates, "legacy-with-bad-bundle");

    expect(legacy?.format).toBe("openclaw");
    expect(hasDiagnosticSourceSuffix(result.diagnostics, bundleMarker)).toBe(true);
  });

  it.each([
    {
      name: "blocks extension entries that escape package directory",
      expectedDiagnostic: "escapes" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "escape-pack");
        const outside = path.join(stateDir, "outside.js");
        mkdirSafe(globalExt);
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/escape-pack",
          extensions: ["../../outside.js"],
        });
        fs.writeFileSync(outside, "export default function () {}", "utf-8");
      },
    },
    {
      name: "blocks parent-segment TypeScript entries before built runtime inference",
      expectedDiagnostic: "escapes" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "escape-pack");
        mkdirSafe(path.join(globalExt, "src"));
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/escape-pack",
          extensions: ["../src/index.ts"],
        });
        fs.writeFileSync(path.join(globalExt, "src", "index.js"), "export default {}", "utf-8");
      },
    },
    {
      name: "blocks escaping source entries before explicit runtime entries",
      expectedDiagnostic: "escapes" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "escape-pack");
        mkdirSafe(path.join(globalExt, "dist"));
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/escape-pack",
          extensions: ["../src/index.ts"],
          runtimeExtensions: ["./dist/index.js"],
        });
        fs.writeFileSync(path.join(globalExt, "dist", "index.js"), "export default {}", "utf-8");
      },
    },
    {
      name: "rejects missing TypeScript package runtime entries without escape diagnostics",
      expectedDiagnostic: "not_found" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "missing-entry-pack");
        mkdirSafe(globalExt);
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/missing-entry-pack",
          extensions: ["./missing.ts"],
        });
        return true;
      },
    },
    {
      name: "rejects package extension entries that escape via symlink",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "pack");
        const outsideDir = path.join(stateDir, "outside");
        const linkedDir = path.join(globalExt, "linked");
        mkdirSafe(globalExt);
        mkdirSafe(outsideDir);
        fs.writeFileSync(path.join(outsideDir, "escape.ts"), "export default {}", "utf-8");
        try {
          symlinkDirectory(outsideDir, linkedDir);
        } catch {
          return false;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./linked/escape.ts"],
        });
        return true;
      },
    },
    {
      name: "rejects package extension entries that are hardlinked aliases",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      expectedDiagnosticPluginId: "pack",
      setup: (stateDir: string) => {
        if (process.platform === "win32") {
          return false;
        }
        const globalExt = path.join(stateDir, "extensions", "pack");
        const outsideDir = path.join(stateDir, "outside");
        const outsideFile = path.join(outsideDir, "escape.ts");
        const linkedFile = path.join(globalExt, "escape.ts");
        mkdirSafe(globalExt);
        mkdirSafe(outsideDir);
        fs.writeFileSync(outsideFile, "export default {}", "utf-8");
        try {
          fs.linkSync(outsideFile, linkedFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return false;
          }
          throw err;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./escape.ts"],
        });
        return true;
      },
    },
    {
      name: "rejects hardlinked TypeScript entries before built runtime inference",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      setup: (stateDir: string) => {
        if (process.platform === "win32") {
          return false;
        }
        const globalExt = path.join(stateDir, "extensions", "pack");
        const outsideDir = path.join(stateDir, "outside");
        const outsideFile = path.join(outsideDir, "escape.ts");
        const linkedFile = path.join(globalExt, "escape.ts");
        mkdirSafe(path.join(globalExt, "dist"));
        mkdirSafe(outsideDir);
        fs.writeFileSync(outsideFile, "export default {}", "utf-8");
        fs.writeFileSync(path.join(globalExt, "dist", "escape.js"), "export default {}", "utf-8");
        try {
          fs.linkSync(outsideFile, linkedFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return false;
          }
          throw err;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./escape.ts"],
        });
        return true;
      },
    },
    {
      name: "rejects hardlinked inferred built runtime entries instead of falling back to source",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      setup: (stateDir: string) => {
        if (process.platform === "win32") {
          return false;
        }
        const globalExt = path.join(stateDir, "extensions", "pack");
        const outsideDir = path.join(stateDir, "outside");
        const outsideFile = path.join(outsideDir, "index.js");
        const linkedFile = path.join(globalExt, "dist", "index.js");
        mkdirSafe(path.join(globalExt, "src"));
        mkdirSafe(path.dirname(linkedFile));
        mkdirSafe(outsideDir);
        fs.writeFileSync(path.join(globalExt, "src", "index.ts"), "export default {}", "utf-8");
        fs.writeFileSync(outsideFile, "export default {}", "utf-8");
        try {
          fs.linkSync(outsideFile, linkedFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return false;
          }
          throw err;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./src/index.ts"],
        });
        return true;
      },
    },
  ] as const)("$name", async ({ setup, expectedDiagnostic, expectedId }) => {
    const stateDir = makeTempDir();
    await expectRejectedPackageExtensionEntry({
      stateDir,
      setup,
      expectedDiagnostic,
      ...(expectedId ? { expectedId } : {}),
    });
  });

  it("blocks escaping setup entries before explicit runtime setup entries", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "escape-pack");
    mkdirSafe(path.join(globalExt, "dist"));
    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/escape-pack",
      extensions: ["./dist/index.js"],
      setupEntry: "../src/setup-entry.ts",
      runtimeSetupEntry: "./dist/setup-entry.js",
    });
    fs.writeFileSync(path.join(globalExt, "dist", "index.js"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(globalExt, "dist", "setup-entry.js"), "export default {}", "utf-8");

    const result = await discoverWithStateDir(stateDir, {});
    const candidate = requireCandidateById(result.candidates, "escape-pack");

    expect(candidate.setupSource).toBeUndefined();
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("ignores package manifests that are hardlinked aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideManifest = path.join(outsideDir, "package.json");
    const linkedManifest = path.join(globalExt, "package.json");
    mkdirSafe(globalExt);
    mkdirSafe(outsideDir);
    fs.writeFileSync(path.join(globalExt, "entry.ts"), "export default {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({
        name: "@openclaw/pack",
        openclaw: { extensions: ["./entry.ts"] },
      }),
      "utf-8",
    );
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const { candidates } = await discoverWithStateDir(stateDir, {});

    expect(candidates.map((candidate) => candidate.idHint)).not.toContain("pack");
  });

  it.runIf(process.platform !== "win32")(
    "rechecks a rejected configured path under bundled policy after deduplicating scoped attempts",
    () => {
      const stateDir = makeTempDir();
      const bundledDir = path.join(stateDir, "bundled");
      const pluginDir = path.join(bundledDir, "repairable");
      createPackagePluginWithEntry({
        packageDir: pluginDir,
        packageName: "repairable",
        entryPath: "index.js",
      });
      fs.chmodSync(pluginDir, 0o777);
      const result = discoverOpenClawPlugins({
        env: buildDiscoveryEnvWithOverrides(stateDir, { OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir }),
        extraPaths: [pluginDir, pluginDir],
      });
      expect(result.candidates).toHaveLength(1);
      expectCandidateFields(result.candidates[0]!, { idHint: "repairable", origin: "bundled" });
      expect(result.diagnostics).toHaveLength(1);
      expectDiagnostic({ diagnostics: result.diagnostics, messageIncludes: "world-writable path" });
      expect(fs.statSync(pluginDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(process.platform !== "win32")("blocks world-writable plugin paths", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "world-open");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/world-open",
      pluginId: "world-open",
    });
    fs.chmodSync(pluginDir, 0o777);

    const result = await discoverWithStateDir(stateDir, {});

    expect(result.candidates).toHaveLength(0);
    expectDiagnostic({
      diagnostics: result.diagnostics,
      messageIncludes: "world-writable path",
    });
  });

  it.runIf(process.platform !== "win32")(
    "repairs world-writable bundled plugin dirs before loading them",
    async () => {
      const stateDir = makeTempDir();
      const packageRoot = path.join(stateDir, "node_modules", "openclaw");
      const bundledDir = path.join(packageRoot, "dist", "extensions");
      const packDir = path.join(bundledDir, "demo-pack");
      mkdirSafe(packDir);
      fs.writeFileSync(path.join(packDir, "index.ts"), "export default function () {}", "utf-8");
      fs.chmodSync(packDir, 0o777);

      const result = withOpenClawPackageArgv(packageRoot, () =>
        discoverOpenClawPlugins({
          env: { ...process.env, ...buildBundledDiscoveryEnv(stateDir) },
        }),
      );

      expect(result.candidates.map((candidate) => candidate.idHint)).toContain("demo-pack");
      expectNoDiagnostic({
        diagnostics: result.diagnostics,
        source: packDir,
        messageIncludes: "world-writable path",
      });
      expect(fs.statSync(packDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "blocks suspicious ownership when uid mismatch is detected",
    async () => {
      const stateDir = makeTempDir();
      createPackagePluginWithEntry({
        packageDir: path.join(stateDir, "extensions", "owner-mismatch"),
        packageName: "@openclaw/owner-mismatch",
        pluginId: "owner-mismatch",
      });

      const actualUid = (process as NodeJS.Process & { getuid: () => number }).getuid();
      const result = await discoverWithStateDir(stateDir, { ownershipUid: actualUid + 1 });
      const shouldBlockForMismatch = actualUid !== 0;
      expect(result.candidates).toHaveLength(shouldBlockForMismatch ? 0 : 1);
      const hasSuspiciousOwnershipDiagnostic = result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("suspicious ownership"),
      );
      expect(hasSuspiciousOwnershipDiagnostic).toBe(shouldBlockForMismatch);
      if (shouldBlockForMismatch) {
        expectDiagnostic({
          diagnostics: result.diagnostics,
          pluginId: "owner-mismatch",
          messageIncludes: "suspicious ownership",
        });
      }
    },
  );

  it.runIf(process.platform !== "win32")("deduplicates blocked candidate diagnostics", () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);
    const blockedDir = path.join(globalExt, "blocked-plugin");
    mkdirSafe(blockedDir);
    fs.writeFileSync(path.join(blockedDir, "index.ts"), "export default function () {}", "utf-8");
    fs.chmodSync(blockedDir, 0o777);

    try {
      const result = discoverOpenClawPlugins({
        env: {
          ...buildDiscoveryEnv(stateDir),
          OPENCLAW_PLUGINS_PATHS: blockedDir,
        },
      });
      const blockedDiagnostics = result.diagnostics.filter(
        (diag) =>
          diag.pluginId === "blocked-plugin" &&
          diag.message.includes("blocked plugin candidate: world-writable path"),
      );
      expect(blockedDiagnostics).toHaveLength(1);
    } finally {
      fs.chmodSync(blockedDir, 0o755);
    }
  });

  it.runIf(process.platform !== "win32")(
    "uses native manifest ids for blocked index-file directory diagnostics",
    () => {
      const stateDir = makeTempDir();
      const pluginDir = path.join(stateDir, "alias-dir");
      mkdirSafe(pluginDir);
      writePluginManifest({ pluginDir, id: "actual-id" });
      writePluginEntry(path.join(pluginDir, "index.ts"));
      fs.chmodSync(pluginDir, 0o777);

      try {
        const result = discoverOpenClawPlugins({
          extraPaths: [pluginDir],
          env: {
            ...buildDiscoveryEnv(stateDir),
          },
        });
        expect(result.candidates).toHaveLength(0);
        const diagnostic = result.diagnostics.find(
          (entry) =>
            entry.pluginId === "actual-id" &&
            (entry.source ?? "").endsWith("alias-dir") &&
            entry.message.includes("blocked plugin candidate: world-writable path"),
        );
        if (!diagnostic) {
          throw new Error("Expected world-writable plugin candidate diagnostic");
        }
      } finally {
        fs.chmodSync(pluginDir, 0o755);
      }
    },
  );

  it("reuses bundled package manifests without repeating filesystem checks", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "cached-bundle");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/cached-bundle",
      pluginId: "cached-bundle",
      entryPath: "index.js",
    });
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const packageManifestPath = path.resolve(pluginDir, "package.json");

    expectCandidatePresence(discoverWithEnv({ env }), { present: ["cached-bundle"] });
    const statSync = vi.spyOn(fs, "statSync");
    const readFileSync = vi.spyOn(fs, "readFileSync");

    expectCandidatePresence(discoverWithEnv({ env }), { present: ["cached-bundle"] });
    expect(
      statSync.mock.calls.filter(
        ([targetPath]) =>
          typeof targetPath === "string" && path.resolve(targetPath) === packageManifestPath,
      ),
    ).toHaveLength(0);
    expect(
      readFileSync.mock.calls.filter(
        ([targetPath]) =>
          typeof targetPath === "string" && path.resolve(targetPath) === packageManifestPath,
      ),
    ).toHaveLength(0);
  });

  it("refreshes same-size bundled package manifests when plugin metadata is reloaded", () => {
    const stateDir = makeTempDir();
    const bundledDir = path.join(stateDir, "bundled");
    const pluginDir = path.join(bundledDir, "cached-bundle");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/cache-one",
      pluginId: "cached-bundle",
      entryPath: "index.js",
    });
    const env = buildDiscoveryEnvWithOverrides(stateDir, {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    });
    const packageManifestPath = path.join(pluginDir, "package.json");
    const unchangedTimestamp = new Date("2025-01-01T00:00:00.000Z");
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);

    const first = discoverWithEnv({ env });
    expect(requireCandidateById(first.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-one",
    );
    const originalStat = fs.statSync(packageManifestPath);
    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/cache-two",
      extensions: ["./index.js"],
    });
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);
    const replacementStat = fs.statSync(packageManifestPath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

    const beforeReload = discoverWithEnv({ env });
    expect(requireCandidateById(beforeReload.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-one",
    );

    clearPluginMetadataLifecycleCaches();

    const afterReload = discoverWithEnv({ env });
    expect(requireCandidateById(afterReload.candidates, "cached-bundle").packageName).toBe(
      "@openclaw/cache-two",
    );
  });

  it("keeps strict global package manifests fixed until a fresh operation", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "fresh-package");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/cache-one",
      pluginId: "fresh-package",
      entryPath: "index.js",
    });
    const env = buildDiscoveryEnv(stateDir);
    const packageManifestPath = path.join(pluginDir, "package.json");
    const unchangedTimestamp = new Date("2025-01-01T00:00:00.000Z");
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);

    const first = discoverWithEnv({ env });
    expect(requireCandidateById(first.candidates, "fresh-package").packageName).toBe(
      "@openclaw/cache-one",
    );
    const originalStat = fs.statSync(packageManifestPath);
    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/cache-two",
      extensions: ["./index.js"],
    });
    fs.utimesSync(packageManifestPath, unchangedTimestamp, unchangedTimestamp);
    const replacementStat = fs.statSync(packageManifestPath);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(replacementStat.mtimeMs).toBe(originalStat.mtimeMs);

    const second = withPluginCache(createPluginCache(), () => discoverWithEnv({ env }));
    expect(requireCandidateById(second.candidates, "fresh-package").packageName).toBe(
      "@openclaw/cache-two",
    );
  });

  it("observes newly installed package manifests only in a fresh operation", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "fresh-package");
    mkdirSafe(pluginDir);
    writePluginManifest({ pluginDir, id: "fresh-package" });
    writePluginEntry(path.join(pluginDir, "index.js"));
    const env = buildDiscoveryEnv(stateDir);
    vi.spyOn(pluginHardlinkPolicy, "shouldRejectHardlinkedPluginFiles").mockReturnValue(false);

    const first = discoverWithEnv({ env });
    expect(requireCandidateById(first.candidates, "fresh-package").packageName).toBeUndefined();

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@openclaw/fresh-package",
      extensions: ["./index.js"],
    });

    const second = withPluginCache(createPluginCache(), () => discoverWithEnv({ env }));
    expect(requireCandidateById(second.candidates, "fresh-package").packageName).toBe(
      "@openclaw/fresh-package",
    );
  });

  it("reflects removed plugin roots in a fresh operation", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "fresh");
    createPackagePluginWithEntry({
      packageDir: pluginDir,
      packageName: "@openclaw/fresh",
      pluginId: "fresh",
    });

    const env = buildDiscoveryEnvWithOverrides(stateDir);
    const first = discoverWithEnv({ env });
    expect(first.candidates.map((candidate) => candidate.idHint)).toContain("fresh");

    fs.rmSync(pluginDir, { recursive: true, force: true });

    const second = withPluginCache(createPluginCache(), () => discoverWithEnv({ env }));
    expect(second.candidates.map((candidate) => candidate.idHint)).not.toContain("fresh");
  });

  it("discovers bundled and global plugins for each workspace-specific scan", () => {
    const stateDir = makeTempDir();
    const packageRoot = path.join(stateDir, "node_modules", "openclaw");
    const bundledDir = path.join(packageRoot, "dist", "extensions");
    const globalExt = path.join(stateDir, "extensions");
    const workspaceA = path.join(stateDir, "workspace-a");
    const workspaceB = path.join(stateDir, "workspace-b");

    createPackagePluginWithEntry({
      packageDir: path.join(bundledDir, "bundled-plugin"),
      packageName: "@openclaw/bundled-plugin",
      pluginId: "bundled-plugin",
    });
    createPackagePluginWithEntry({
      packageDir: path.join(globalExt, "global-plugin"),
      packageName: "@openclaw/global-plugin",
      pluginId: "global-plugin",
    });
    createPackagePluginWithEntry({
      packageDir: path.join(workspaceA, ".openclaw", "extensions", "workspace-a-plugin"),
      packageName: "@openclaw/workspace-a-plugin",
      pluginId: "workspace-a-plugin",
    });
    createPackagePluginWithEntry({
      packageDir: path.join(workspaceB, ".openclaw", "extensions", "workspace-b-plugin"),
      packageName: "@openclaw/workspace-b-plugin",
      pluginId: "workspace-b-plugin",
    });

    const env = {
      ...buildDiscoveryEnv(stateDir),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    };
    const first = withOpenClawPackageArgv(packageRoot, () =>
      discoverWithEnv({ workspaceDir: workspaceA, env }),
    );
    expectCandidatePresence(first, {
      present: ["bundled-plugin", "global-plugin", "workspace-a-plugin"],
      absent: ["workspace-b-plugin"],
    });

    const second = withOpenClawPackageArgv(packageRoot, () =>
      discoverWithEnv({ workspaceDir: workspaceB, env }),
    );
    expectCandidatePresence(second, {
      present: ["bundled-plugin", "global-plugin", "workspace-b-plugin"],
      absent: ["workspace-a-plugin"],
    });

    const bundledOnly = withOpenClawPackageArgv(packageRoot, () =>
      discoverWithEnv({
        workspaceDir: workspaceA,
        extraPaths: [path.join(stateDir, "missing-configured-plugin")],
        installRecords: { missing: { source: "npm", installPath: stateDir } },
        rootScope: "bundled",
        env,
      }),
    );
    expect(bundledOnly.candidates.map((candidate) => candidate.idHint)).toEqual(["bundled-plugin"]);
    expect(bundledOnly.diagnostics).toEqual([]);
  });

  it.each([
    {
      name: "does not reuse discovery results across env root changes",
      setup: () => {
        const stateDirA = makeTempDir();
        const stateDirB = makeTempDir();
        createPackagePluginWithEntry({
          packageDir: path.join(stateDirA, "extensions", "alpha"),
          packageName: "@openclaw/alpha",
          pluginId: "alpha",
        });
        createPackagePluginWithEntry({
          packageDir: path.join(stateDirB, "extensions", "beta"),
          packageName: "@openclaw/beta",
          pluginId: "beta",
        });
        return {
          first: discoverWithEnv({ env: buildDiscoveryEnvWithOverrides(stateDirA) }),
          second: discoverWithEnv({ env: buildDiscoveryEnvWithOverrides(stateDirB) }),
          assert: (
            first: ReturnType<typeof discoverWithEnv>,
            second: ReturnType<typeof discoverWithEnv>,
          ) => {
            expectCandidatePresence(first, { present: ["alpha"], absent: ["beta"] });
            expectCandidatePresence(second, { present: ["beta"], absent: ["alpha"] });
          },
        };
      },
    },
    {
      name: "does not reuse extra-path discovery across env home changes",
      setup: () => {
        const stateDir = makeTempDir();
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const pluginA = path.join(homeA, "plugins", "demo.ts");
        const pluginB = path.join(homeB, "plugins", "demo.ts");
        writeStandalonePlugin(pluginA, "export default {}");
        writeStandalonePlugin(pluginB, "export default {}");
        return {
          first: discoverWithEnv({
            extraPaths: ["~/plugins/demo.ts"],
            env: buildDiscoveryEnvWithOverrides(stateDir, { HOME: homeA }),
          }),
          second: discoverWithEnv({
            extraPaths: ["~/plugins/demo.ts"],
            env: buildDiscoveryEnvWithOverrides(stateDir, { HOME: homeB }),
          }),
          assert: (
            first: ReturnType<typeof discoverWithEnv>,
            second: ReturnType<typeof discoverWithEnv>,
          ) => {
            expectCandidateSource(first.candidates, "demo", pluginA);
            expectCandidateSource(second.candidates, "demo", pluginB);
          },
        };
      },
    },
  ] as const)("$name", ({ setup }) => {
    const { first, second, assert } = setup();
    assert(first, second);
  });

  it("discovers standalone files from configured load-path directories", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins");
    const pluginPath = path.join(pluginDir, "alpha.ts");
    writeStandalonePlugin(pluginPath, "export default {}");

    const result = discoverWithEnv({
      extraPaths: [pluginDir],
      env: buildDiscoveryEnvWithOverrides(stateDir),
    });

    expectCandidateSource(result.candidates, "alpha", pluginPath);
  });

  it("preserves configured load-path order", () => {
    const stateDir = makeTempDir();
    const pluginA = path.join(stateDir, "plugins", "alpha.ts");
    const pluginB = path.join(stateDir, "plugins", "beta.ts");
    writeStandalonePlugin(pluginA, "export default {}");
    writeStandalonePlugin(pluginB, "export default {}");

    const env = buildDiscoveryEnvWithOverrides(stateDir);

    const first = discoverWithEnv({
      extraPaths: [pluginA, pluginB],
      env,
    });
    const second = discoverWithEnv({
      extraPaths: [pluginB, pluginA],
      env,
    });

    expectCandidateOrder(first.candidates, ["alpha", "beta"]);
    expectCandidateOrder(second.candidates, ["beta", "alpha"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
