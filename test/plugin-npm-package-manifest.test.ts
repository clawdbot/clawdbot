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
  const [packResult] = JSON.parse(result.stdout) as [
    {
      files?: { path?: string }[];
    },
  ];
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
    writeJsonFile(join(packageDir, "npm-shrinkwrap.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "@openclaw/diffs",
          version: "2026.5.3",
        },
      },
    });

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
      files: [
        "dist/**",
        "openclaw.plugin.json",
        "npm-shrinkwrap.json",
        "README.md",
        "SKILL.md",
        "skills/**",
      ],
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
        expect(stagedPackageJson.files).toContain("npm-shrinkwrap.json");
        expect(stagedPackageJson.files).toContain("skills/**");
        expect(stagedPackageJson.peerDependencies.openclaw).toBe(">=2026.4.30");
        expect(stagedPackageJson.peerDependenciesMeta.openclaw.optional).toBe(true);
      },
    );
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
  });

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
    writeJsonFile(join(packageDir, "npm-shrinkwrap.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "@openclaw/diffs",
          version: "2026.5.3",
          dependencies: {
            "local-runtime-dep": "file:./deps/local-runtime-dep",
          },
        },
        "deps/local-runtime-dep": {
          name: "local-runtime-dep",
          version: "1.0.0",
        },
        "node_modules/local-runtime-dep": {
          resolved: "deps/local-runtime-dep",
          link: true,
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
      },
    );

    expect(existsSync(nodeModulesPath)).toBe(false);
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
    writeJsonFile(join(packageDir, "npm-shrinkwrap.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "@openclaw/diffs",
          version: "2026.5.3",
          dependencies: {
            "local-runtime-dep": "file:./deps/local-runtime-dep",
          },
        },
        "deps/local-runtime-dep": {
          name: "local-runtime-dep",
          version: "1.0.0",
          optionalDependencies: {
            "optional-platform-dep": "file:../../deps/optional-platform-dep",
          },
        },
        "deps/optional-platform-dep": {
          version: "1.0.0",
          optional: true,
          os: [process.platform === "win32" ? "darwin" : "win32"],
        },
        "node_modules/local-runtime-dep": {
          resolved: "deps/local-runtime-dep",
          link: true,
        },
        "node_modules/optional-platform-dep": {
          resolved: "deps/optional-platform-dep",
          link: true,
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
    writeJsonFile(join(packageDir, "npm-shrinkwrap.json"), {
      name: "@openclaw/diffs",
      version: "2026.5.3",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "@openclaw/diffs",
          version: "2026.5.3",
          dependencies: {
            "local-runtime-dep": "file:./deps/local-runtime-dep",
          },
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
