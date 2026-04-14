import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageBundledPluginRuntimeDeps } from "../../scripts/stage-bundled-plugin-runtime-deps.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("stageBundledPluginRuntimeDeps", () => {
  function createBundledPluginFixture(params: {
    packageJson: Record<string, unknown>;
    pluginId?: string;
  }) {
    const repoRoot = createTempDir("openclaw-runtime-deps-");
    const pluginId = params.pluginId ?? "fixture-plugin";
    const pluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(params.packageJson, null, 2)}\n`,
      "utf8",
    );
    return { pluginDir, repoRoot };
  }

  it("skips restaging when runtime deps stamp matches the sanitized manifest", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        peerDependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          openclaw: "^1.0.0",
          react: "^19.0.0",
        },
        peerDependenciesMeta: {
          "@openclaw/plugin-sdk": { optional: true },
          openclaw: { optional: true },
          react: { optional: true },
        },
        devDependencies: {
          "@openclaw/plugin-sdk": "workspace:*",
          openclaw: "^1.0.0",
          typescript: "^5.9.0",
        },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "present\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: () => {
        installCount += 1;
      },
    });

    expect(installCount).toBe(1);
    expect(fs.existsSync(path.join(nodeModulesDir, "marker.txt"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"))).toEqual({
      name: "@openclaw/fixture-plugin",
      version: "1.0.0",
      dependencies: { "left-pad": "1.3.0" },
      openclaw: { bundle: { stageRuntimeDependencies: true } },
    });
  });

  it("restages when the manifest-owned runtime deps change", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    const stageOnce = () =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
          installCount += 1;
          const nodeModulesDir = path.join(pluginDir, "node_modules");
          fs.mkdirSync(nodeModulesDir, { recursive: true });
          fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), `${installCount}\n`, "utf8");
          fs.writeFileSync(
            path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
            `${JSON.stringify({ fingerprint }, null, 2)}\n`,
            "utf8",
          );
        },
      });

    stageOnce();
    const updatedPackageJson = JSON.parse(
      fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"),
    );
    updatedPackageJson.dependencies["is-odd"] = "3.0.1";
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify(updatedPackageJson, null, 2)}\n`,
      "utf8",
    );
    stageOnce();

    expect(installCount).toBe(2);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe("2\n");
  });

  it("stages runtime deps from the root node_modules when already installed", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "left-pad", "version": "1.3.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(rootDepDir, "index.js"), "module.exports = 1;\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "left-pad", "index.js"), "utf8"),
    ).toBe("module.exports = 1;\n");
    expect(fs.existsSync(path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"))).toBe(true);
  });

  it("stages hoisted transitive runtime deps from the root node_modules", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    const transitiveDir = path.join(repoRoot, "node_modules", "transitive");
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(transitiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0", "dependencies": { "transitive": "^1.2.0" } }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 'direct';\n", "utf8");
    fs.writeFileSync(
      path.join(transitiveDir, "package.json"),
      '{ "name": "transitive", "version": "1.2.3" }\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(transitiveDir, "index.js"),
      "module.exports = 'transitive';\n",
      "utf8",
    );

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "direct", "index.js"), "utf8"),
    ).toBe("module.exports = 'direct';\n");
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "transitive", "index.js"), "utf8"),
    ).toBe("module.exports = 'transitive';\n");
  });

  it("removes global non-runtime suffixes from staged runtime dependencies", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const directDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(
      path.join(directDir, "package.json"),
      '{ "name": "direct", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(directDir, "index.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(directDir, "index.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(directDir, "index.js.map"), '{ "version": 3 }\n', "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.d.ts"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "direct", "index.js.map"))).toBe(
      false,
    );
  });

  it("applies package-specific cargo prune rules after staging", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "rule-target": "1.0.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const depDir = path.join(repoRoot, "node_modules", "rule-target");
    fs.mkdirSync(path.join(depDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(depDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      '{ "name": "rule-target", "version": "1.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(depDir, "lib", "index.js"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(depDir, "lib", "index.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(depDir, "docs", "guide.md"), "docs\n", "utf8");
    fs.writeFileSync(path.join(depDir, "README.md"), "readme\n", "utf8");
    fs.writeFileSync(path.join(depDir, "LICENSE"), "license\n", "utf8");

    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      stagedRuntimeDepPruneRules: new Map([
        ["rule-target", { paths: ["docs", "README.md"], suffixes: [".d.ts"] }],
      ]),
    });

    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "lib", "index.js")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "lib", "index.d.ts")),
    ).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "docs"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "README.md"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "rule-target", "LICENSE"))).toBe(
      true,
    );
  });

  it("applies default prune rules for known heavy non-runtime package cargo", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: {
          "@cloudflare/workers-types": "1.0.0",
          "@jimp/plugin-blit": "1.0.0",
          gifwrap: "1.0.0",
          "playwright-core": "1.0.0",
        },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootNodeModules = path.join(repoRoot, "node_modules");
    const writePackage = (name: string) => {
      const depDir = path.join(rootNodeModules, ...name.split("/"));
      fs.mkdirSync(depDir, { recursive: true });
      fs.writeFileSync(
        path.join(depDir, "package.json"),
        `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
        "utf8",
      );
      return depDir;
    };
    const cloudflareDir = writePackage("@cloudflare/workers-types");
    fs.writeFileSync(path.join(cloudflareDir, "index.d.ts"), "export {};\n", "utf8");
    const gifwrapDir = writePackage("gifwrap");
    fs.mkdirSync(path.join(gifwrapDir, "test", "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(gifwrapDir, "test", "fixtures", "large.gif"), "fixture\n", "utf8");
    const playwrightDir = writePackage("playwright-core");
    fs.mkdirSync(path.join(playwrightDir, "types"), { recursive: true });
    fs.writeFileSync(path.join(playwrightDir, "types", "types.d.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(playwrightDir, "index.js"), "export {};\n", "utf8");
    const jimpDir = writePackage("@jimp/plugin-blit");
    fs.mkdirSync(path.join(jimpDir, "src", "__image_snapshots__"), { recursive: true });
    fs.writeFileSync(
      path.join(jimpDir, "src", "__image_snapshots__", "snapshot.png"),
      "fixture\n",
      "utf8",
    );
    fs.writeFileSync(path.join(jimpDir, "index.js"), "export {};\n", "utf8");

    stageBundledPluginRuntimeDeps({ cwd: repoRoot });

    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "@cloudflare", "workers-types")),
    ).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "gifwrap", "test"))).toBe(false);
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "playwright-core", "types"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(pluginDir, "node_modules", "playwright-core", "index.js"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(pluginDir, "node_modules", "@jimp", "plugin-blit", "src", "__image_snapshots__"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(pluginDir, "node_modules", "@jimp", "plugin-blit", "index.js")),
    ).toBe(true);
  });

  it("falls back to staging installs when the root dependency version is incompatible", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "^1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "left-pad");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "left-pad", "version": "2.0.0" }\n',
      "utf8",
    );
    fs.writeFileSync(path.join(rootDepDir, "index.js"), "module.exports = 'root';\n", "utf8");

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "left-pad");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "left-pad", "version": "1.3.0" }\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(nodeModulesDir, "index.js"),
          "module.exports = 'nested';\n",
          "utf8",
        );
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });

    expect(installCount).toBe(1);
    expect(
      fs.readFileSync(path.join(pluginDir, "node_modules", "left-pad", "index.js"), "utf8"),
    ).toBe("module.exports = 'nested';\n");
  });

  it("falls back when a ^0.0.x root dependency exceeds the patch ceiling", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { tiny: "^0.0.3" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "tiny");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "tiny", "version": "0.0.5" }\n',
      "utf8",
    );

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "tiny");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "tiny", "version": "0.0.3" }\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });

    expect(installCount).toBe(1);
  });

  it("falls back when a stable caret range only matches a prerelease root build", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { direct: "^1.2.3" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });
    const rootDepDir = path.join(repoRoot, "node_modules", "direct");
    fs.mkdirSync(rootDepDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDepDir, "package.json"),
      '{ "name": "direct", "version": "1.3.0-beta.1" }\n',
      "utf8",
    );

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        const nodeModulesDir = path.join(pluginDir, "node_modules", "direct");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
          path.join(nodeModulesDir, "package.json"),
          '{ "name": "direct", "version": "1.2.3" }\n',
          "utf8",
        );
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });

    expect(installCount).toBe(1);
  });

  it("retries transient runtime dependency staging failures before surfacing an error", () => {
    const { pluginDir, repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    stageBundledPluginRuntimeDeps({
      cwd: repoRoot,
      installPluginRuntimeDepsImpl: ({ fingerprint }: { fingerprint: string }) => {
        installCount += 1;
        if (installCount < 3) {
          throw new Error(`attempt ${installCount} failed`);
        }
        const nodeModulesDir = path.join(pluginDir, "node_modules");
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(nodeModulesDir, "marker.txt"), "ok\n", "utf8");
        fs.writeFileSync(
          path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"),
          `${JSON.stringify({ fingerprint }, null, 2)}\n`,
          "utf8",
        );
      },
    });

    expect(installCount).toBe(3);
    expect(fs.readFileSync(path.join(pluginDir, "node_modules", "marker.txt"), "utf8")).toBe(
      "ok\n",
    );
  });

  it("surfaces the last staging error after exhausting retries", () => {
    const { repoRoot } = createBundledPluginFixture({
      packageJson: {
        name: "@openclaw/fixture-plugin",
        version: "1.0.0",
        dependencies: { "left-pad": "1.3.0" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      },
    });

    let installCount = 0;
    expect(() =>
      stageBundledPluginRuntimeDeps({
        cwd: repoRoot,
        installAttempts: 2,
        installPluginRuntimeDepsImpl: () => {
          installCount += 1;
          throw new Error(`attempt ${installCount} failed`);
        },
      }),
    ).toThrow("attempt 2 failed");
    expect(installCount).toBe(2);
  });
});
