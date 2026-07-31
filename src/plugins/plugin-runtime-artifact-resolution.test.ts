import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  clearActivatedPluginRuntimeState,
  clearPluginRegistryLoadCache,
  loadOpenClawPlugins,
} from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { pinActivePluginChannelRegistry } from "./runtime.js";

const tempDirs: string[] = [];

function createBundledPluginFixture(): {
  rootDir: string;
  source: string;
  builtSource: string;
} {
  const packageRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-artifact-")),
  );
  tempDirs.push(packageRoot);
  const rootDir = path.join(packageRoot, "extensions", "fixture");
  const source = path.join(rootDir, "index.ts");
  const builtSource = path.join(packageRoot, "dist", "extensions", "fixture", "index.js");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(builtSource), { recursive: true });
  fs.writeFileSync(source, "export default { register() {} };\n");
  fs.writeFileSync(builtSource, 'module.exports = { id: "fixture", register() {} };\n');
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    rootDir: fs.realpathSync(rootDir),
    source: fs.realpathSync(source),
    builtSource: fs.realpathSync(builtSource),
  };
}

function resolveFixture(params: {
  rootDir: string;
  source: string;
  preferBuiltPluginArtifacts: boolean;
}) {
  return resolvePluginRuntimeArtifact({
    pluginId: "fixture",
    entryKind: "runtime",
    rootDir: params.rootDir,
    source: params.source,
    origin: "bundled",
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
  });
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePluginRuntimeArtifact", () => {
  it.each([
    { firstPreference: false, firstArtifact: "source" },
    { firstPreference: true, firstArtifact: "built" },
  ])(
    "pins the first $firstArtifact path so one plugin instance registers once",
    ({ firstPreference }) => {
      const fixture = createBundledPluginFixture();
      const first = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: firstPreference,
      });
      const second = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: !firstPreference,
      });

      expect(first.source).toBe(firstPreference ? fixture.builtSource : fixture.source);
      expect(second).toEqual(first);
    },
  );

  it("aliases different physical inputs for the same logical runtime entry", () => {
    const fixture = createBundledPluginFixture();
    const first = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });
    const aliased = resolvePluginRuntimeArtifact({
      pluginId: "fixture",
      entryKind: "runtime",
      rootDir: fixture.rootDir,
      source: fixture.builtSource,
      origin: "bundled",
      preferBuiltPluginArtifacts: true,
    });

    expect(aliased).toEqual(first);
  });

  it("keeps runtime and setup entries distinct within one plugin root", () => {
    const fixture = createBundledPluginFixture();
    const setupSource = path.join(fixture.rootDir, "setup-entry.ts");
    fs.writeFileSync(setupSource, "export default { register() {} };\n");
    const runtime = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });
    const setup = resolvePluginRuntimeArtifact({
      pluginId: "fixture",
      entryKind: "setup",
      rootDir: fixture.rootDir,
      source: fs.realpathSync(setupSource),
      origin: "bundled",
      preferBuiltPluginArtifacts: false,
    });

    expect(runtime.source).toBe(fixture.source);
    expect(setup.source).toBe(fs.realpathSync(setupSource));
  });

  it("re-resolves after activated runtime state is cleared", () => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });

    clearActivatedPluginRuntimeState();

    const builtResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: true,
    });
    expect(sourceResolution.source).toBe(fixture.source);
    expect(builtResolution.source).toBe(fixture.builtSource);
  });

  it("re-resolves after the registry load cache is cleared", () => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });

    clearPluginRegistryLoadCache();

    const builtResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: true,
    });
    expect(sourceResolution.source).toBe(fixture.source);
    expect(builtResolution.source).toBe(fixture.builtSource);
  });

  it("keeps one physical entry across activating registry assemblies", () => {
    const fixture = createBundledPluginFixture();
    const config = {
      plugins: {
        allow: ["fixture"],
        entries: { fixture: { enabled: true } },
      },
    };

    const [first, second] = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(fixture.rootDir),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () => {
        const sourceRegistry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: false,
        });
        pinActivePluginChannelRegistry(sourceRegistry);
        const builtPreferredRegistry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: true,
        });
        return [sourceRegistry, builtPreferredRegistry];
      },
    );

    expect(first.plugins.find((plugin) => plugin.id === "fixture")?.source).toBe(fixture.source);
    expect(second.plugins.find((plugin) => plugin.id === "fixture")?.source).toBe(fixture.source);
  });

  it("leaves dist-only installs unchanged because both preferences resolve the built entry", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-dist-only-")),
    );
    tempDirs.push(packageRoot);
    const rootDir = path.join(packageRoot, "dist", "extensions", "fixture");
    const source = path.join(rootDir, "index.js");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(source, "export default { register() {} };\n");
    const canonicalRootDir = fs.realpathSync(rootDir);
    const canonicalSource = fs.realpathSync(source);

    const sourcePreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: false,
    });
    clearPluginRuntimeArtifactResolutionMemo();
    const builtPreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: true,
    });

    expect(sourcePreferred).toEqual({ source: canonicalSource, rootDir: canonicalRootDir });
    expect(builtPreferred).toEqual(sourcePreferred);
  });
});
