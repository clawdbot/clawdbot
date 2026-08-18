// Plugin npm manifest tests validate generated plugin package manifests.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePluginNpmPackageLockWithRetry,
  resolveAugmentedPluginNpmPackageJson,
  resolveAugmentedPluginNpmManifest,
  resolvePluginNpmCommand,
  runPluginNpmCiWithRetry,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];
const tsxImport = import.meta.resolve("tsx");

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

  it("retries timed-out bundled dependency installs after cleaning partial output", () => {
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawnResults = [
      { error: timeoutError, status: null },
      { error: undefined, status: 0 },
    ];
    const spawnOptions: SpawnSyncOptions[] = [];
    let cleanupCalls = 0;

    const result = runPluginNpmCiWithRetry(
      ["ci"],
      { cwd: "/tmp/plugin" },
      {
        cleanupAttempt: () => {
          cleanupCalls += 1;
        },
        pluginDir: "whatsapp",
        spawn: (_args: string[], options: SpawnSyncOptions) => {
          spawnOptions.push(options);
          return spawnResults.shift();
        },
        timeoutMs: 1234,
      },
    ) as { status: number | null };

    expect(result.status).toBe(0);
    expect(cleanupCalls).toBe(1);
    expect(spawnOptions).toEqual([
      { cwd: "/tmp/plugin", timeout: 1234 },
      { cwd: "/tmp/plugin", timeout: 1234 },
    ]);
  });

  it("does not retry ordinary bundled dependency install failures", () => {
    let spawnCalls = 0;
    const result = runPluginNpmCiWithRetry(
      ["ci"],
      {},
      {
        cleanupAttempt: () => {
          throw new Error("cleanup should not run");
        },
        spawn: () => {
          spawnCalls += 1;
          return { error: undefined, status: 1 };
        },
      },
    ) as { status: number | null };

    expect(result.status).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it("cleans an exhausted timeout before reusing the same package directory", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-timeout-");
    const packageDir = join(repoDir, "extensions", "whatsapp");
    const nodeModulesPath = join(packageDir, "node_modules");
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    mkdirSync(packageDir, { recursive: true });

    const firstResult = runPluginNpmCiWithRetry(
      ["ci"],
      { cwd: packageDir },
      {
        attempts: 3,
        cleanupAttempt: () => rmSync(nodeModulesPath, { recursive: true, force: true }),
        pluginDir: "whatsapp",
        spawn: () => {
          mkdirSync(nodeModulesPath, { recursive: true });
          return { error: timeoutError, status: null };
        },
      },
    ) as { error?: NodeJS.ErrnoException };

    expect(firstResult.error?.code).toBe("ETIMEDOUT");
    expect(existsSync(nodeModulesPath)).toBe(false);

    const secondResult = runPluginNpmCiWithRetry(
      ["ci"],
      { cwd: packageDir },
      {
        cleanupAttempt: () => rmSync(nodeModulesPath, { recursive: true, force: true }),
        pluginDir: "whatsapp",
        spawn: () => {
          expect(existsSync(nodeModulesPath)).toBe(false);
          return { error: undefined, status: 0 };
        },
      },
    ) as { status: number | null };

    expect(secondResult.status).toBe(0);
  });

  it("retries timed-out package-lock generation with a bounded command timeout", () => {
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const generateOptions: Array<Record<string, unknown>> = [];
    let generateCalls = 0;

    const lock = generatePluginNpmPackageLockWithRetry(
      "/tmp/plugin",
      { installStrategy: "shallow" },
      {
        generate: (_packageDir: string, options: Record<string, unknown>) => {
          generateCalls += 1;
          generateOptions.push(options);
          if (generateCalls === 1) {
            throw timeoutError;
          }
          return '{"lockfileVersion":3}\n';
        },
        pluginDir: "whatsapp",
      },
    );

    expect(lock).toBe('{"lockfileVersion":3}\n');
    expect(generateOptions).toHaveLength(2);
    expect(generateOptions[0]).toMatchObject({
      env: { OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "180000" },
      installStrategy: "shallow",
    });
    expect(generateOptions[1]).toEqual(generateOptions[0]);
  });

  it("does not retry ordinary package-lock generation failures", () => {
    let generateCalls = 0;
    expect(() =>
      generatePluginNpmPackageLockWithRetry(
        "/tmp/plugin",
        { installStrategy: "shallow" },
        {
          generate: () => {
            generateCalls += 1;
            throw new Error("invalid dependency");
          },
        },
      ),
    ).toThrow("invalid dependency");
    expect(generateCalls).toBe(1);
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
    const sourcePackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    sourcePackageJson.openclaw.channel = {
      id: "diffs",
      configuredState: {
        specifier: "./configured-state",
        exportName: "hasConfiguredChannelState",
      },
    };
    writeJsonFile(join(packageDir, "package.json"), sourcePackageJson);
    writeFileText(
      join(packageDir, "configured-state.ts"),
      "export function hasConfiguredChannelState() {}\n",
    );
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    writeFileText(
      join(packageDir, "dist", "configured-state.js"),
      "export function hasConfiguredChannelState() { return true; }\n",
    );

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
        channel: {
          id: "diffs",
          configuredState: {
            specifier: "./dist/configured-state.js",
            exportName: "hasConfiguredChannelState",
          },
        },
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
        expect(stagedPackageJson.openclaw.channel.configuredState.specifier).toBe(
          "./dist/configured-state.js",
        );
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

  it("packs and loads both mapped channel-state probes from one package artifact", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-npm-package-state-runtime-");
    const packageDir = writePublishablePluginPackage(repoDir);
    const sourcePackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    sourcePackageJson.openclaw.build = { runtimeFormat: "cjs" };
    sourcePackageJson.openclaw.channel = {
      id: "diffs",
      configuredState: {
        specifier: "./configured-state",
        exportName: "hasConfiguredChannelState",
      },
      persistedAuthState: {
        specifier: "./dist/auth-presence.cjs",
        exportName: "hasPersistedChannelAuth",
      },
    };
    writeJsonFile(join(packageDir, "package.json"), sourcePackageJson);
    writeFileText(
      join(packageDir, "configured-state.ts"),
      "export function hasConfiguredChannelState() {}\n",
    );
    writeFileText(
      join(packageDir, "auth-presence.ts"),
      "export function hasPersistedChannelAuth() {}\n",
    );
    writeFileText(join(packageDir, "dist", "index.cjs"), "module.exports = {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.cjs"), "module.exports = {};\n");
    writeFileText(
      join(packageDir, "dist", "configured-state.cjs"),
      "exports.hasConfiguredChannelState = () => true;\n",
    );
    writeFileText(
      join(packageDir, "dist", "auth-presence.cjs"),
      "exports.hasPersistedChannelAuth = () => true;\n",
    );

    const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
    withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
      const stagedPackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      expect(stagedPackageJson.openclaw.channel.configuredState).toEqual({
        specifier: "./dist/configured-state.cjs",
        exportName: "hasConfiguredChannelState",
      });
      expect(stagedPackageJson.openclaw.channel.persistedAuthState).toEqual({
        specifier: "./dist/auth-presence.cjs",
        exportName: "hasPersistedChannelAuth",
      });

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
      const [packedPackage] = JSON.parse(pack.stdout) as [
        { filename: string; files: Array<{ path: string }> },
      ];
      const packedFiles = packedPackage.files.map((file) => file.path);
      expect(packedFiles).toContain("dist/configured-state.cjs");
      expect(packedFiles).toContain("dist/auth-presence.cjs");
      expect(packedFiles).not.toContain("configured-state.ts");
      expect(packedFiles).not.toContain("auth-presence.ts");

      const extract = spawnSync(
        "tar",
        ["-xzf", join(consumerDir, packedPackage.filename), "-C", consumerDir],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(extract.status, extract.stderr).toBe(0);

      const packageRoot = join(consumerDir, "package");
      const load = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(packageRoot)};
const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
for (const key of ["configuredState", "persistedAuthState"]) {
  const state = pkg.openclaw.channel[key];
  const loaded = await import(new URL(state.specifier, pathToFileURL(root + "/")));
  if (loaded[state.exportName]?.() !== true) throw new Error("packed state checker failed: " + key);
}
process.stdout.write("PACKED_PLUGIN_CHANNEL_STATE_OK\\n");
`,
        ],
        {
          cwd: packageRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(load.status, load.stderr).toBe(0);
      expect(load.stdout).toBe("PACKED_PLUGIN_CHANNEL_STATE_OK\n");
    });
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
  });

  it("stages portable bundled dependencies without polluting pack output", () => {
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
    const manifestModuleUrl = new URL(
      "../scripts/lib/plugin-npm-package-manifest.mts",
      import.meta.url,
    ).href;
    const childSource = `
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolvePluginNpmCommand,
  withAugmentedPluginNpmManifestForPackage,
} from ${JSON.stringify(manifestModuleUrl)};

const packageDir = ${JSON.stringify(packageDir)};
const nodeModulesPath = ${JSON.stringify(nodeModulesPath)};
withAugmentedPluginNpmManifestForPackage(
  {
    repoRoot: ${JSON.stringify(repoDir)},
    packageDir,
    bundleDependencies: true,
  },
  () => {
    const stagedPackageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (JSON.stringify(stagedPackageJson.bundledDependencies) !== '["local-runtime-dep"]') {
      throw new Error("bundled dependencies were not staged");
    }
    if (stagedPackageJson.bundleDependencies || stagedPackageJson.devDependencies) {
      throw new Error("unpublishable dependency metadata remained staged");
    }
    if (!existsSync(join(nodeModulesPath, "local-runtime-dep", "package.json"))) {
      throw new Error("missing bundled runtime dependency");
    }
    if (!existsSync(join(nodeModulesPath, "optional-platform-dep", "package.json"))) {
      throw new Error("missing portable optional bundled dependency");
    }
    if (existsSync(join(packageDir, "package-lock.json"))) {
      throw new Error("package lock remained staged");
    }
    const invocation = resolvePluginNpmCommand(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const pack = spawnSync(invocation.command, invocation.args, {
      cwd: packageDir,
      encoding: "utf8",
      ...(invocation.env ? { env: invocation.env } : {}),
      ...(invocation.shell !== undefined ? { shell: invocation.shell } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      ...(invocation.windowsVerbatimArguments !== undefined
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    if (pack.status !== 0) throw new Error(pack.stderr || "npm pack failed");
    const [packedPackage] = JSON.parse(pack.stdout);
    const packedFiles = packedPackage.files.map((file) => file.path);
    if (!packedFiles.includes("node_modules/local-runtime-dep/package.json")) {
      throw new Error("bundled runtime dependency was not packed");
    }
    if (packedFiles.includes("package-lock.json") || packedFiles.includes("npm-shrinkwrap.json")) {
      throw new Error("package lock was packed");
    }
    process.stdout.write("pack-json\\n");
  },
);
`;
    const result = spawnSync(
      process.execPath,
      ["--import", tsxImport, "--input-type=module", "--eval", childSource],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pack-json\n");

    expect(existsSync(nodeModulesPath)).toBe(false);
    expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
    expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
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
