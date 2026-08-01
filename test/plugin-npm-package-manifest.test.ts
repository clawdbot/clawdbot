// Plugin npm manifest tests validate generated plugin package manifests.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAugmentedPluginNpmPackageJson,
  resolveAugmentedPluginNpmManifest,
  resolvePluginNpmCommand,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mjs";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeGeneratedChannelMetadata(repoDir: string): void {
  const metadataPath = join(
    repoDir,
    "src",
    "config",
    "bundled-channel-config-metadata.generated.ts",
  );
  mkdirSync(join(repoDir, "src", "config"), { recursive: true });
  writeFileText(
    metadataPath,
    `export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = [
  {
    pluginId: "twitch",
    channelId: "twitch",
    label: "Twitch",
    description: "Twitch chat integration",
    schema: {
      type: "object",
      required: ["channelName"],
      properties: {
        channelName: { type: "string" },
      },
    },
  },
] as const;
`,
  );
}

function writeFileText(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // writeJsonFile intentionally owns JSON formatting only.
  writeFileSync(filePath, text, "utf8");
}

function listNpmPackDryRunFiles(packageDir: string): string[] {
  const invocation = resolvePluginNpmCommand(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(invocation.shell !== undefined ? { shell: invocation.shell } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `npm pack failed with exit ${result.status}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const packResult = (
    Array.isArray(parsed)
      ? parsed[0]
      : parsed && typeof parsed === "object" && "files" in parsed
        ? parsed
        : parsed && typeof parsed === "object"
          ? Object.values(parsed)[0]
          : undefined
  ) as { files?: { path?: string }[] } | undefined;
  return (packResult?.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
}

function writePublishablePluginPackage(repoDir: string): string {
  const packageDir = join(repoDir, "extensions", "diffs");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(packageDir, "package.json"), {
    name: "@openclaw/diffs",
    version: "2026.5.3",
    type: "module",
    openclaw: {
      extensions: ["./index.ts"],
      setupEntry: "./setup-entry.ts",
      compat: {
        pluginApi: ">=2026.4.30",
      },
      release: {
        publishToNpm: true,
      },
    },
  });
  writeJsonFile(join(packageDir, "openclaw.plugin.json"), { id: "diffs" });
  writeFileText(join(packageDir, "README.md"), "# Diffs\n");
  writeFileText(join(packageDir, "SKILL.md"), "# Diffs Skill\n");
  writeFileText(join(packageDir, "skills", "diffs", "SKILL.md"), "# Diffs Skill\n");
  return packageDir;
}

function writeLocalDependencyPackage(
  packageDir: string,
  options: { optionalDependencySpec?: string } = {},
): void {
  const dependencyDir = join(packageDir, "deps", "local-runtime-dep");
  mkdirSync(dependencyDir, { recursive: true });
  writeJsonFile(join(dependencyDir, "package.json"), {
    name: "local-runtime-dep",
    version: "1.0.0",
    main: "index.js",
    ...(options.optionalDependencySpec
      ? {
          optionalDependencies: {
            "optional-platform-dep": options.optionalDependencySpec,
          },
        }
      : {}),
  });
  writeFileText(join(dependencyDir, "index.js"), "module.exports = 1;\n");
}

function writeOptionalPlatformDependencyPackage(packageDir: string): string {
  const dependencyDir = join(packageDir, "deps", "optional-platform-dep");
  mkdirSync(dependencyDir, { recursive: true });
  writeJsonFile(join(dependencyDir, "package.json"), {
    name: "optional-platform-dep",
    version: "1.0.0",
    main: "index.js",
    os: [process.platform === "win32" ? "darwin" : "win32"],
  });
  writeFileText(join(dependencyDir, "index.js"), "module.exports = 2;\n");
  return dependencyDir;
}

describe("plugin npm package manifest staging", () => {
  it("keeps msteams runtime dependencies registry-installed", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "extensions", "msteams", "package.json"), "utf8"),
    ) as { openclaw?: { release?: { bundleRuntimeDependencies?: boolean } } };

    expect(packageJson.openclaw?.release?.bundleRuntimeDependencies).toBe(false);
  });

  it("wraps Windows npm.cmd staging through cmd.exe without shell mode", () => {
    const nodeDir = "C:\\Program Files\\nodejs";
    const npmCmdPath = win32.resolve(nodeDir, "npm.cmd");

    expect(
      resolvePluginNpmCommand(["install", "--package-lock-only"], {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: { PATH: "C:\\bin" },
        execPath: win32.join(nodeDir, "node.exe"),
        existsSync: (candidate: string) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\npm.cmd" install --package-lock-only"',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("rejects bare npm fallback on Windows plugin package staging", () => {
    expect(() =>
      resolvePluginNpmCommand(["install"], {
        execPath: "C:\\nodejs\\node.exe",
        existsSync: () => false,
        platform: "win32",
      }),
    ).toThrow("OpenClaw refuses to shell out to bare npm on Windows");
  });

  it("overlays generated channel configs while packing and restores source manifest", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-manifest-");
    const packageDir = join(repoDir, "extensions", "twitch");
    mkdirSync(packageDir, { recursive: true });
    const sourceManifest = {
      id: "twitch",
      channels: ["twitch"],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    };
    writeJsonFile(join(packageDir, "openclaw.plugin.json"), sourceManifest);
    writeGeneratedChannelMetadata(repoDir);

    const resolved = resolveAugmentedPluginNpmManifest({
      repoRoot: repoDir,
      packageDir,
    });
    expect(resolved.changed).toBe(true);
    expect(resolved.manifest).toEqual({
      id: "twitch",
      channels: ["twitch"],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      channelConfigs: {
        twitch: {
          description: "Twitch chat integration",
          label: "Twitch",
          schema: {
            type: "object",
            required: ["channelName"],
            properties: {
              channelName: { type: "string" },
            },
          },
        },
      },
    });

    const originalText = readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8");
    withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
      const stagedManifest = JSON.parse(
        readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8"),
      );
      expect(stagedManifest.channelConfigs.twitch.description).toBe("Twitch chat integration");
    });
    expect(readFileSync(join(packageDir, "openclaw.plugin.json"), "utf8")).toBe(originalText);
  });

  it("overlays package-local runtime metadata while packing and restores source package json", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");

    const resolved = resolveAugmentedPluginNpmPackageJson({
      repoRoot: repoDir,
      packageDir,
      bundleDependencies: true,
    });
    expect(resolved.changed).toBe(true);
    expect(resolved.packageJson).toEqual({
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      bundledDependencies: [],
      files: ["dist/**", "openclaw.plugin.json", "README.md", "SKILL.md", "skills/**"],
      peerDependencies: {
        openclaw: ">=2026.4.30",
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./dist/setup-entry.js",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
        runtimeExtensions: ["./dist/index.js"],
        runtimeSetupEntry: "./dist/setup-entry.js",
      },
    });

    const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
    withAugmentedPluginNpmManifestForPackage(
      { repoRoot: repoDir, packageDir, bundleDependencies: true },
      () => {
        const stagedPackageJson = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
        expect(stagedPackageJson.openclaw.extensions).toEqual(["./index.ts"]);
        expect(stagedPackageJson.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
        expect(stagedPackageJson.openclaw.setupEntry).toBe("./dist/setup-entry.js");
        expect(stagedPackageJson.openclaw.runtimeSetupEntry).toBe("./dist/setup-entry.js");
        expect(stagedPackageJson.bundledDependencies).toEqual([]);
        expect(stagedPackageJson.bundleDependencies).toBeUndefined();
        expect(stagedPackageJson.files).toContain("dist/**");
        expect(stagedPackageJson.files).not.toContain("package-lock.json");
        expect(stagedPackageJson.files).toContain("skills/**");
        expect(stagedPackageJson.peerDependencies.openclaw).toBe(">=2026.4.30");
        expect(stagedPackageJson.peerDependenciesMeta.openclaw.optional).toBe(true);
      },
    );
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
  });

  it.each(
    [
      {
        label: "ESM configured-state",
        metadataKey: "configuredState",
        runtimeFormat: "esm",
        sourceName: "configured-state",
        exportName: "hasConfiguredChannelState",
      },
      {
        label: "CommonJS configured-state",
        metadataKey: "configuredState",
        runtimeFormat: "cjs",
        sourceName: "configured-state",
        exportName: "hasConfiguredChannelState",
      },
      {
        label: "ESM persisted-auth state",
        metadataKey: "persistedAuthState",
        runtimeFormat: "esm",
        sourceName: "auth-presence",
        exportName: "hasPersistedChannelAuth",
      },
      {
        label: "CommonJS persisted-auth state",
        metadataKey: "persistedAuthState",
        runtimeFormat: "cjs",
        sourceName: "auth-presence",
        exportName: "hasPersistedChannelAuth",
      },
    ].flatMap((testCase) => [
      { ...testCase, label: `${testCase.label} from source`, specifierKind: "source" },
      { ...testCase, label: `${testCase.label} from built runtime`, specifierKind: "runtime" },
    ]),
  )(
    "packs and loads $label from the actual installed plugin runtime",
    ({ metadataKey, runtimeFormat, sourceName, exportName, specifierKind }) => {
      const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-state-runtime-");
      const packageDir = writePublishablePluginPackage(repoDir);
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const sourceSpecifier = `./${sourceName}`;
      const runtimeSpecifier = `./dist/${sourceName}${extension}`;
      const sourcePackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      sourcePackageJson.openclaw.channel = {
        id: "diffs",
        [metadataKey]: {
          specifier: specifierKind === "runtime" ? runtimeSpecifier : sourceSpecifier,
          exportName,
        },
      };
      if (runtimeFormat === "cjs") {
        sourcePackageJson.openclaw.build = { runtimeFormat: "cjs" };
      }
      writeJsonFile(join(packageDir, "package.json"), sourcePackageJson);
      writeFileText(join(packageDir, `${sourceName}.ts`), `export function ${exportName}() {}\n`);
      writeFileText(join(packageDir, "dist", `index${extension}`), "export {};\n");
      writeFileText(join(packageDir, "dist", `setup-entry${extension}`), "export {};\n");
      writeFileText(
        join(packageDir, "dist", `${sourceName}${extension}`),
        runtimeFormat === "cjs"
          ? `exports.${exportName} = () => true;\n`
          : `export function ${exportName}() { return true; }\n`,
      );

      const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
      withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
        const stagedPackageJson = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
        expect(stagedPackageJson.openclaw.channel[metadataKey]).toEqual({
          specifier: runtimeSpecifier,
          exportName,
        });

        const packedFiles = listNpmPackDryRunFiles(packageDir);
        expect(packedFiles).toContain(runtimeSpecifier.slice(2));
        expect(packedFiles).not.toContain(`${sourceName}.ts`);

        const consumerDir = join(repoDir, "external-consumer");
        mkdirSync(consumerDir, { recursive: true });
        writeJsonFile(join(consumerDir, "package.json"), { private: true, type: "module" });

        const packInvocation = resolvePluginNpmCommand([
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          consumerDir,
        ]);
        const pack = spawnSync(packInvocation.command, packInvocation.args, {
          cwd: packageDir,
          encoding: "utf8",
          ...(packInvocation.env ? { env: packInvocation.env } : {}),
          ...(packInvocation.shell !== undefined ? { shell: packInvocation.shell } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          ...(packInvocation.windowsVerbatimArguments !== undefined
            ? { windowsVerbatimArguments: packInvocation.windowsVerbatimArguments }
            : {}),
        });
        expect(pack.status, pack.stderr).toBe(0);
        const [packedPackage] = JSON.parse(pack.stdout) as [{ filename: string }];

        const installInvocation = resolvePluginNpmCommand([
          "install",
          "--ignore-scripts",
          "--omit=peer",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          join(consumerDir, packedPackage.filename),
        ]);
        const install = spawnSync(installInvocation.command, installInvocation.args, {
          cwd: consumerDir,
          encoding: "utf8",
          ...(installInvocation.env ? { env: installInvocation.env } : {}),
          ...(installInvocation.shell !== undefined ? { shell: installInvocation.shell } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          ...(installInvocation.windowsVerbatimArguments !== undefined
            ? { windowsVerbatimArguments: installInvocation.windowsVerbatimArguments }
            : {}),
        });
        expect(install.status, install.stderr).toBe(0);

        const installedRoot = join(consumerDir, "node_modules", "@openclaw", "diffs");
        const load = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import fs from "node:fs";\n` +
              `import { pathToFileURL } from "node:url";\n` +
              `const root = ${JSON.stringify(installedRoot)};\n` +
              `const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));\n` +
              `const state = pkg.openclaw.channel[${JSON.stringify(metadataKey)}];\n` +
              `const loaded = await import(new URL(state.specifier, pathToFileURL(root + "/")));\n` +
              `if (loaded[state.exportName]?.() !== true) throw new Error("installed state checker failed");\n` +
              `process.stdout.write("INSTALLED_PLUGIN_CHANNEL_STATE_OK\\n");\n`,
          ],
          { cwd: consumerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        expect(load.status, load.stderr).toBe(0);
        expect(load.stdout).toBe("INSTALLED_PLUGIN_CHANNEL_STATE_OK\n");
      });
      expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
    },
  );

  it("installs and cleans package-local bundled dependencies while packing", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-bundled-deps-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeLocalDependencyPackage(packageDir);
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      dependencies: {
        "local-runtime-dep": "file:./deps/local-runtime-dep",
      },
      devDependencies: {
        "@openclaw/plugin-sdk": "workspace:*",
      },
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
    const nodeModulesPath = join(packageDir, "node_modules");
    expect(existsSync(nodeModulesPath)).toBe(false);

    withAugmentedPluginNpmManifestForPackage(
      { repoRoot: repoDir, packageDir, bundleDependencies: true },
      () => {
        const stagedPackageJson = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
        expect(stagedPackageJson.bundledDependencies).toEqual(["local-runtime-dep"]);
        expect(stagedPackageJson.bundleDependencies).toBeUndefined();
        expect(stagedPackageJson.devDependencies).toBeUndefined();
        expect(existsSync(join(nodeModulesPath, "local-runtime-dep", "package.json"))).toBe(true);
        expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
        const packedFiles = listNpmPackDryRunFiles(packageDir);
        expect(packedFiles).toContain("node_modules/local-runtime-dep/package.json");
        expect(packedFiles).not.toContain("package-lock.json");
        expect(packedFiles).not.toContain("npm-shrinkwrap.json");
      },
    );

    expect(existsSync(nodeModulesPath)).toBe(false);
    expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
  });

  it("force-installs missing optional bundled dependencies for portable packs", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-portable-optional-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeOptionalPlatformDependencyPackage(packageDir);
    writeLocalDependencyPackage(packageDir, {
      optionalDependencySpec: "file:../../deps/optional-platform-dep",
    });
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      dependencies: {
        "local-runtime-dep": "file:./deps/local-runtime-dep",
      },
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    const nodeModulesPath = join(packageDir, "node_modules");
    const manifestModuleUrl = new URL(
      "../scripts/lib/plugin-npm-package-manifest.mjs",
      import.meta.url,
    ).href;
    const childSource = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withAugmentedPluginNpmManifestForPackage } from ${JSON.stringify(manifestModuleUrl)};

const packageDir = ${JSON.stringify(packageDir)};
const nodeModulesPath = ${JSON.stringify(nodeModulesPath)};
withAugmentedPluginNpmManifestForPackage(
  {
    repoRoot: ${JSON.stringify(repoDir)},
    packageDir,
    bundleDependencies: true,
  },
  () => {
    if (!existsSync(join(nodeModulesPath, "local-runtime-dep", "package.json"))) {
      throw new Error("missing bundled runtime dependency");
    }
    if (!existsSync(join(nodeModulesPath, "optional-platform-dep", "package.json"))) {
      throw new Error("missing portable optional bundled dependency");
    }
    process.stdout.write("pack-json\\n");
  },
);
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: repoDir,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pack-json\n");

    expect(existsSync(nodeModulesPath)).toBe(false);
  });

  it("honors plugin package opt-out for bundled runtime dependencies", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-bundle-opt-out-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeLocalDependencyPackage(packageDir);
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      dependencies: {
        "local-runtime-dep": "file:./deps/local-runtime-dep",
      },
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
          bundleRuntimeDependencies: false,
        },
      },
    });

    const resolved = resolveAugmentedPluginNpmPackageJson({
      repoRoot: repoDir,
      packageDir,
      bundleDependencies: true,
    });
    expect(resolved.bundleDependencies).toBe(false);
    expect(resolved.packageJson?.bundledDependencies).toBeUndefined();
    expect(resolved.packageJson?.devDependencies).toBeUndefined();

    const nodeModulesPath = join(packageDir, "node_modules");
    withAugmentedPluginNpmManifestForPackage(
      { repoRoot: repoDir, packageDir, bundleDependencies: true },
      () => {
        const stagedPackageJson = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
        expect(stagedPackageJson.bundledDependencies).toBeUndefined();
        expect(existsSync(nodeModulesPath)).toBe(false);
      },
    );
  });

  it("refuses to pack publishable plugins before package-local runtime files exist", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-missing-");
    const packageDir = writePublishablePluginPackage(repoDir);

    expect(() =>
      resolveAugmentedPluginNpmPackageJson({
        repoRoot: repoDir,
        packageDir,
      }),
    ).toThrow(
      "package-local plugin runtime is missing for diffs: ./dist/index.js, ./dist/setup-entry.js",
    );
  });

  it("refuses package file rules that omit advertised package-local runtime files", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-runtime-excluded-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeJsonFile(join(packageDir, "package.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      type: "module",
      files: ["dist/**", "!dist/setup-entry.js"],
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        compat: {
          pluginApi: ">=2026.4.30",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    const packedFiles = listNpmPackDryRunFiles(packageDir);
    expect(packedFiles).toContain("dist/index.js");
    expect(packedFiles).not.toContain("dist/setup-entry.js");

    expect(() =>
      resolveAugmentedPluginNpmPackageJson({
        repoRoot: repoDir,
        packageDir,
      }),
    ).toThrow(
      "package file rule '!dist/setup-entry.js' excludes required package-local runtime file './dist/setup-entry.js' for diffs",
    );
  });
});
