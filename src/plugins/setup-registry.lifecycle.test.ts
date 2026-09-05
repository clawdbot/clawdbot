import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  retirePluginCache,
  transferPluginCacheSetupModules,
  waitForPluginCacheRetirement,
  withPluginCache,
} from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginSetupProviderCore, resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  await waitForPluginCacheRetirement();
  cleanupTrackedTempDirs(tempDirs);
  vi.unstubAllEnvs();
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
    { artifactDir: ".", declared: false, competingDist: "setup-api.js" },
  ])(
    "reloads and retires $artifactDir setup graphs (declared: $declared, dist conflict: $competingDist)",
    async ({ artifactDir, declared, competingDist }) => {
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
        fs.writeFileSync(
          path.join(artifactRoot, "lazy.cjs"),
          `module.exports = "lazy-${version}";\n`,
          "utf8",
        );
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          setupSource,
          `process.on("openclaw.setup-lifecycle-proof", () => {}); module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + require("./setup-dependency.cjs") }); api.registerConfigMigration(config => ({ config, changes: [require("./lazy.cjs")] })); } };\n`,
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
      const before = resolvePluginSetupRegistry({ manifestRegistry });
      expect(before.providers[0]?.provider.label).toBe("entry-before:dependency-before");
      expect(process.listenerCount("openclaw.setup-lifecycle-proof")).toBe(1);
      writeSetupArtifact("after");
      expect(before.configMigrations[0]?.migrate({})?.changes).toEqual(["lazy-before"]);
      clearPluginMetadataLifecycleCaches();
      expect(() => before.configMigrations[0]?.migrate({})).toThrow(/reloaded|disabled/);
      await waitForPluginCacheRetirement();
      expect(process.listenerCount("openclaw.setup-lifecycle-proof")).toBe(0);
      const after = resolvePluginSetupRegistry({ manifestRegistry });
      expect(after.providers[0]?.provider.label).toBe("entry-after:dependency-after");
      expect(after.configMigrations[0]?.migrate({})?.changes).toEqual(["lazy-after"]);
    },
  );

  it("routes new setup queries from retained runtime scopes to the published cache", async () => {
    const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-retained", tempDirs));
    const source = path.join(rootDir, "setup-api.cjs");
    const write = (value: string) =>
      fs.writeFileSync(
        source,
        `module.exports = { register(api) { api.registerConfigMigration(config => ({ config, changes: [${JSON.stringify(value)}] })); } };`,
      );
    const manifestRegistry = {
      plugins: [
        {
          id: "retained-setup",
          rootDir,
          source,
          setupSource: source,
          manifestPath: path.join(rootDir, "openclaw.plugin.json"),
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          setup: { requiresRuntime: true },
        },
      ],
      diagnostics: [],
    } satisfies PluginManifestRegistry;
    const previous = createPluginCache({ kind: "process" });
    adoptProcessPluginCache(previous);
    write("original");
    const before = resolvePluginSetupRegistry({ manifestRegistry }).configMigrations[0]!;
    write("edited");
    const next = createPluginCache({ kind: "process" });
    transferPluginCacheSetupModules(previous, next, new Set());
    adoptProcessPluginCache(next);
    await retirePluginCache(previous);
    const retained = withPluginCache(previous, () =>
      resolvePluginSetupRegistry({ manifestRegistry }),
    );
    expect(retained.diagnostics).toEqual([]);
    expect(retained.configMigrations[0]?.migrate({})?.changes).toEqual(["original"]);
    expect(before.migrate({})?.changes).toEqual(["original"]);
    const operation = createPluginCache();
    const candidate = withPluginCache(operation, () =>
      resolvePluginSetupRegistry({ manifestRegistry }),
    );
    expect(candidate.configMigrations[0]?.migrate({})?.changes).toEqual(["edited"]);
    await retirePluginCache(operation);
    expect(() => candidate.configMigrations[0]?.migrate({})).toThrow(/reloaded|disabled/);
    expect(before.migrate({})?.changes).toEqual(["original"]);
  });

  it("isolates cached mutable setup values from a managed TypeScript module", () => {
    const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-mutable", tempDirs));
    const source = path.join(rootDir, "setup-api.ts");
    fs.writeFileSync(
      source,
      `const label: string = "Original";
      export default { register(api) {
        api.registerProvider({ id: "mutable-setup", label, aliases: ["original"], auth: [] });
        api.registerCliBackend({ id: "mutable-cli", config: { command: "fixture", args: ["run"] } });
        api.registerConfigMigration(config => ({ config, changes: [label] }));
      } };`,
    );
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "mutable-setup",
          rootDir,
          source,
          setupSource: source,
          origin: "global",
          providers: ["mutable-setup"],
          cliBackends: ["mutable-cli"],
          setup: {
            requiresRuntime: true,
            providers: [{ id: "mutable-setup" }],
            cliBackends: ["mutable-cli"],
          },
        },
      ],
    });
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        const first = resolvePluginSetupRegistry();
        first.providers[0]!.provider.label = "Changed";
        first.providers[0]!.provider.aliases!.push("changed");
        first.cliBackends[0]!.backend.config!.args!.push("changed");
        const second = resolvePluginSetupRegistry();
        expect(second.providers[0]?.provider).toMatchObject({
          label: "Original",
          aliases: ["original"],
        });
        expect(second.cliBackends[0]?.backend.config?.args).toEqual(["run"]);
        expect(second.configMigrations[0]?.migrate({})?.changes).toEqual(["Original"]);
        clearPluginMetadataLifecycleCaches();
        expect(() => second.configMigrations[0]?.migrate({})).toThrow(/reloaded|disabled/);
      },
      { trustConfigIdentity: true },
    );
  });

  it.each(["dist", "dist-runtime"])(
    "reruns bundled %s setup registration while preserving process module identity",
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
          `let calls = 0; module.exports = { register(api) { api.registerProvider({ id: "bundled-setup", label: "entry-${version}:" + require(${JSON.stringify(dependencyImport)}) + ":" + ++calls }); } };\n`,
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
        "entry-before:dependency-before:1",
      );

      writeBundledArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before:2",
      );
    },
  );
});
