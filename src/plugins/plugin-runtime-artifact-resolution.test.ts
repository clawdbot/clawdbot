import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { getActivePluginChannelRegistry } from "./runtime.js";

const tempDirs: string[] = [];

function createBundledPluginFixture(builtExtension = ".js"): {
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
  const builtSource = path.join(
    packageRoot,
    "dist",
    "extensions",
    "fixture",
    `index${builtExtension}`,
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(builtSource), { recursive: true });
  fs.writeFileSync(source, "export default { register() {} };\n");
  fs.writeFileSync(builtSource, 'module.exports = { id: "fixture", register() {} };\n');
  fs.writeFileSync(
    path.join(path.dirname(builtSource), "package.json"),
    JSON.stringify({
      openclaw: { extensions: [`./index${builtExtension}`], build: { runtimeFormat: "cjs" } },
    }),
  );
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
  it.each([".cjs", ".js"])(
    "uses the emitted %s entry rather than a stale format neighbor",
    (extension) => {
      const fixture = createBundledPluginFixture(extension);
      const staleExtension = extension === ".js" ? ".cjs" : ".js";
      fs.writeFileSync(
        path.join(path.dirname(fixture.builtSource), `index${staleExtension}`),
        'throw new Error("stale build format");\n',
      );

      expect(resolveFixture({ ...fixture, preferBuiltPluginArtifacts: true }).source).toBe(
        fixture.builtSource,
      );
    },
  );

  it("keeps the bundled root build ahead of adjacent source output", () => {
    const fixture = createBundledPluginFixture();
    fs.writeFileSync(path.join(fixture.rootDir, "index.js"), 'module.exports = { id: "stale" };\n');

    expect(resolveFixture({ ...fixture, preferBuiltPluginArtifacts: true }).source).toBe(
      fixture.builtSource,
    );
  });

  it("does not replace missing declared CJS output with a stale JavaScript neighbor", () => {
    const fixture = createBundledPluginFixture(".cjs");
    fs.rmSync(fixture.builtSource);
    fs.writeFileSync(
      path.join(path.dirname(fixture.builtSource), "index.js"),
      "export default {};\n",
    );

    expect(resolveFixture({ ...fixture, preferBuiltPluginArtifacts: true }).source).toBe(
      fixture.source,
    );
  });

  it("never borrows a checkout root build for an installed package", () => {
    const fixture = createBundledPluginFixture();
    expect(
      resolvePluginRuntimeArtifact({
        ...fixture,
        pluginId: "fixture",
        entryKind: "runtime",
        origin: "global",
        preferBuiltPluginArtifacts: true,
      }).source,
    ).toBe(fixture.source);
  });

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

  it("prefers the root build for source-external plugins without using package-local output", () => {
    const fixture = createBundledPluginFixture();
    const packageLocalSource = path.join(fixture.rootDir, "dist", "index.js");
    fs.mkdirSync(path.dirname(packageLocalSource), { recursive: true });
    fs.writeFileSync(packageLocalSource, 'module.exports = { id: "stale" };\n');

    const resolved = resolvePluginRuntimeArtifact({
      pluginId: "fixture",
      entryKind: "runtime",
      rootDir: fixture.rootDir,
      source: fixture.source,
      origin: "bundled",
      preferBuiltPluginArtifacts: true,
      packageManifest: { build: { bundledDist: false } },
    });

    expect(resolved.source).toBe(fixture.builtSource);
    expect(resolved.source).not.toBe(fs.realpathSync(packageLocalSource));
  });

  it.each([
    { entryKind: "runtime" as const, sourceName: "index.ts", artifactName: "index.js" },
    {
      entryKind: "setup" as const,
      sourceName: "setup-entry.ts",
      artifactName: "setup-entry.js",
    },
    {
      entryKind: "provider-discovery" as const,
      sourceName: "provider-discovery.ts",
      artifactName: "provider-discovery.js",
    },
  ])(
    "keeps source-external $entryKind entries inside their selected root after packaging",
    ({ entryKind, sourceName, artifactName }) => {
      const fixture = createBundledPluginFixture();
      const packageRoot = path.dirname(path.dirname(fixture.rootDir));
      const source = path.join(fixture.rootDir, sourceName);
      if (source !== fixture.source) {
        fs.writeFileSync(source, "export default { register() {} };\n");
      }
      const stagingSource = path.join(
        packageRoot,
        "dist-runtime",
        "extensions",
        "fixture",
        artifactName,
      );
      fs.mkdirSync(path.dirname(stagingSource), { recursive: true });
      fs.writeFileSync(
        stagingSource,
        `export * from "../../../dist/extensions/fixture/${artifactName}";\n`,
      );
      fs.rmSync(path.dirname(fixture.builtSource), { recursive: true });
      const packagedSource = path.join(
        packageRoot,
        "dist",
        "extensions",
        "fixture",
        "dist",
        artifactName,
      );
      fs.mkdirSync(path.dirname(packagedSource), { recursive: true });
      fs.writeFileSync(packagedSource, 'module.exports = { id: "packed" };\n');
      fs.writeFileSync(
        path.join(packageRoot, "dist", "extensions", "fixture", "package.json"),
        JSON.stringify({
          openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
        }),
      );

      const resolved = resolvePluginRuntimeArtifact({
        pluginId: "fixture",
        entryKind,
        rootDir: fixture.rootDir,
        source,
        origin: "bundled",
        preferBuiltPluginArtifacts: true,
        packageManifest: { build: { bundledDist: false } },
      });

      expect(resolved).toEqual({ source: fs.realpathSync(source), rootDir: fixture.rootDir });
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

  it.each(["setup", "provider-discovery"] as const)(
    "keeps runtime and %s entries distinct within one plugin root",
    (entryKind) => {
      const fixture = createBundledPluginFixture();
      const setupSource = path.join(fixture.rootDir, "setup-entry.ts");
      fs.writeFileSync(setupSource, "export default { register() {} };\n");
      const runtime = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: false,
      });
      const setup = resolvePluginRuntimeArtifact({
        pluginId: "fixture",
        entryKind,
        rootDir: fixture.rootDir,
        source: fs.realpathSync(setupSource),
        origin: "bundled",
        preferBuiltPluginArtifacts: false,
      });

      expect(runtime.source).toBe(fixture.source);
      expect(setup.source).toBe(fs.realpathSync(setupSource));
    },
  );

  it("re-resolves after the active registry memo is cleared", () => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });

    clearPluginRuntimeArtifactResolutionMemo();

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

  it("resolves replacement artifacts independently while pinned consumers keep their registry", () => {
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
        const builtPreferredRegistry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: true,
        });
        return [sourceRegistry, builtPreferredRegistry];
      },
    );

    expect([...first.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.source,
    ]);
    expect([...second.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.builtSource,
    ]);
    expect(getActivePluginChannelRegistry()).toBe(second);
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
