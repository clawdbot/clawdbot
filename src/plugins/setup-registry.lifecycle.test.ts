import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("plugin setup registry artifact lifecycle", () => {
  it("reloads replaced installed setup modules and their dependencies", () => {
    const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-lifecycle", tempDirs));
    const setupSource = path.join(rootDir, "setup-api.cjs");
    const dependencyPath = path.join(rootDir, "setup-dependency.cjs");
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
          setupSource,
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
  });

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
