import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginSetupProviderCore, resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("plugin setup registry artifact lifecycle", () => {
  it.each([undefined, ["trace-provider"], []])(
    "traces prepared setup lookup with plugin IDs %j",
    (pluginIds) => {
      const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-trace", tempDirs));
      const setupSource = path.join(rootDir, "setup-api.cjs");
      fs.writeFileSync(
        setupSource,
        'module.exports = { register(api) { api.registerProvider({ id: "trace-provider", label: "Trace provider" }); } };\n',
      );
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "trace-provider",
            rootDir,
            origin: "global",
            setupSource,
            setup: { requiresRuntime: true, providers: [{ id: "trace-provider" }] },
          },
        ],
      });
      vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", "1");
      const trace = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const provider = withPluginMetadataSnapshotScope(
        snapshot,
        () => resolvePluginSetupProviderCore({ provider: "trace-provider", pluginIds }),
        { trustConfigIdentity: true },
      );

      expect(provider?.label).toBe(pluginIds?.length === 0 ? undefined : "Trace provider");
      const phases = trace.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes('phase="manifest registry"'));
      const pluginIdCount = pluginIds ? ` pluginIdCount=${pluginIds.length}` : "";
      expect(phases).toEqual([
        expect.stringMatching(
          new RegExp(
            `^\\[plugins:lifecycle\\] phase="manifest registry" ms=\\d+\\.\\d{2} status=ok includeDisabled=true${pluginIdCount} indexPluginCount=1$`,
          ),
        ),
      ]);
    },
  );

  it.each<{
    artifactDir: string;
    declared: boolean;
    competingDist?: string;
  }>([
    { artifactDir: ".", declared: true },
    { artifactDir: ".", declared: false },
    { artifactDir: "dist", declared: false },
    { artifactDir: ".", declared: false, competingDist: "setup-api.ts" },
    {
      artifactDir: ".",
      declared: false,
      competingDist: "setup-api.js",
    },
  ])(
    "reloads installed $artifactDir setup artifacts (declared: $declared, dist conflict: $competingDist)",
    ({ artifactDir, declared, competingDist }) => {
      const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-lifecycle", tempDirs));
      const artifactRoot = path.join(rootDir, artifactDir);
      fs.mkdirSync(artifactRoot, { recursive: true });
      const setupSource = path.join(artifactRoot, "setup-api.cjs");
      const dependencyPath = path.join(artifactRoot, "setup-dependency.cjs");
      if (competingDist) {
        fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
        fs.writeFileSync(
          path.join(rootDir, "dist", competingDist),
          'module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "wrong-dist-entry" }); } };\n',
          "utf8",
        );
      }
      const writeSetupArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          setupSource,
          `module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + require("./setup-dependency.cjs") }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "setup-lifecycle",
            rootDir,
            source: setupSource,
            ...(declared ? { setupSource } : {}),
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "global",
            channels: [],
            providers: ["setup-lifecycle"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "setup-lifecycle" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeSetupArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeSetupArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );

  it.each(["dist", "dist-runtime"])(
    "reloads bundled setup artifacts and their dependencies from %s",
    (artifactRootName) => {
      const packageRoot = fs.realpathSync(
        makeTrackedTempDir("openclaw-bundled-setup-lifecycle", tempDirs),
      );
      const rootDir = path.join(packageRoot, "extensions", "bundled-setup");
      const artifactRoot = path.join(packageRoot, artifactRootName, "extensions", "bundled-setup");
      fs.mkdirSync(rootDir, { recursive: true });
      fs.mkdirSync(artifactRoot, { recursive: true });
      fs.writeFileSync(
        path.join(artifactRoot, "package.json"),
        JSON.stringify({ openclaw: { setupEntry: "./setup-api.js" } }),
      );
      const sourcePath = path.join(rootDir, "setup-api.ts");
      const artifactPath = path.join(artifactRoot, "setup-api.js");
      const dependencyPath =
        artifactRootName === "dist"
          ? path.join(packageRoot, artifactRootName, "setup-dependency.cjs")
          : path.join(artifactRoot, "setup-dependency.cjs");
      const dependencyImport =
        artifactRootName === "dist" ? "../../setup-dependency.cjs" : "./setup-dependency.cjs";
      fs.writeFileSync(sourcePath, "export {};\n", "utf8");
      const writeBundledArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          artifactPath,
          `module.exports = { register(api) { api.registerProvider({ id: "bundled-setup", label: "entry-${version}:" + require(${JSON.stringify(dependencyImport)}) }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "bundled-setup",
            rootDir,
            source: sourcePath,
            setupSource: sourcePath,
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "bundled",
            channels: [],
            providers: ["bundled-setup"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "bundled-setup" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeBundledArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeBundledArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );
});
