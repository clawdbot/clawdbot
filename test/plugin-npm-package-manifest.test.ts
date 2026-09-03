// Plugin npm manifest tests validate generated plugin package manifests.
import { execFile, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePluginNpmPackageLockWithRetry,
  resolveAugmentedPluginNpmPackageJson,
  resolveAugmentedPluginNpmManifest,
  resolvePluginNpmCommand,
  runPluginNpmCiWithRetry,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mts";
import { hasChannelPackageState } from "../src/channels/plugins/package-state-probes.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];
const tsxImport = import.meta.resolve("tsx");
const execFileAsync = promisify(execFile);

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

type NpmPackResult = { filename: string; files: Array<{ path: string }> };

function parseNpmPackResult(stdout: string): NpmPackResult {
  const parsed = JSON.parse(stdout) as unknown;
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "files" in parsed
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const [packResult] = candidates;
  if (
    !packResult ||
    typeof packResult !== "object" ||
    !("filename" in packResult) ||
    typeof packResult.filename !== "string" ||
    !("files" in packResult) ||
    !Array.isArray(packResult.files) ||
    !packResult.files.every(
      (file: unknown) =>
        file !== null &&
        typeof file === "object" &&
        "path" in file &&
        typeof file.path === "string",
    )
  ) {
    throw new Error("npm pack --json did not return a package result");
  }
  return packResult as NpmPackResult;
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
  return parseNpmPackResult(result.stdout).files.map((entry) => entry.path);
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

function writePatchedRuntimeFixture(bundling = "default") {
  const optionalDirect = bundling === "optional-direct" || bundling === "skipped-optional";
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-patched-artifact-");
  const packageDir = writePublishablePluginPackage(repoDir);
  writeLocalDependencyPackage(packageDir);
  const packRegistryDependency = (name: string) => {
    const dependencyDir = join(packageDir, "deps", name);
    const manifest = JSON.parse(readFileSync(join(dependencyDir, "package.json"), "utf8"));
    const pack = spawnSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", repoDir],
      {
        cwd: dependencyDir,
        encoding: "utf8",
      },
    );
    expect(pack.status, pack.stderr).toBe(0);
    const tarball = readFileSync(join(repoDir, parseNpmPackResult(pack.stdout).filename));
    return {
      manifest,
      tarball,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    };
  };
  const registryVersions = [packRegistryDependency("local-runtime-dep")];
  if (bundling === "nested-other") {
    writeJsonFile(join(packageDir, "deps", "local-runtime-dep", "package.json"), {
      name: "local-runtime-dep",
      version: "2.0.0",
      main: "index.js",
    });
    writeFileText(
      join(packageDir, "deps", "local-runtime-dep", "index.js"),
      "module.exports = 20;\n",
    );
    registryVersions.push(packRegistryDependency("local-runtime-dep"));
  }
  const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  sourceManifest.files = ["deps/**"];
  sourceManifest.dependencies = {
    "local-runtime-dep": "1.0.0",
    "unpatched-sibling": "file:./deps/unpatched-sibling",
  };
  writeJsonFile(join(packageDir, "deps", "unpatched-sibling", "package.json"), {
    name: "unpatched-sibling",
    version: "1.0.0",
    main: "index.js",
    ...(bundling.startsWith("nested-")
      ? {
          optionalDependencies: {
            "local-runtime-dep": bundling === "nested-other" ? "2.0.0" : "1.0.0",
          },
        }
      : {}),
  });
  writeFileText(
    join(packageDir, "deps", "unpatched-sibling", "index.js"),
    bundling.startsWith("nested-")
      ? 'module.exports = require("local-runtime-dep");\n'
      : "module.exports = 3;\n",
  );
  if (bundling.startsWith("nested-")) {
    sourceManifest.dependencies["unpatched-sibling"] = "1.0.0";
    registryVersions.push(packRegistryDependency("unpatched-sibling"));
  }
  if (bundling === "range-policy") {
    delete sourceManifest.dependencies["unpatched-sibling"];
    sourceManifest.overrides = {
      "local-runtime-dep@^1.0.0": { ".": "^1.0.0", "unpatched-sibling": "1.0.0" },
    };
    registryVersions.push(packRegistryDependency("unpatched-sibling"));
    writeJsonFile(join(packageDir, "deps", "unpatched-sibling", "package.json"), {
      name: "unpatched-sibling",
      version: "1.1.0",
      main: "index.js",
    });
    writeFileText(
      join(packageDir, "deps", "unpatched-sibling", "index.js"),
      "module.exports = 4;\n",
    );
    registryVersions.push(packRegistryDependency("unpatched-sibling"));
  }
  if (optionalDirect) {
    sourceManifest.dependencies["local-runtime-dep"] = "0.0.0";
    sourceManifest.optionalDependencies = { "local-runtime-dep": "1.0.0" };
  }
  if (bundling === "partial") {
    sourceManifest.bundledDependencies = ["unpatched-sibling"];
  } else if (bundling === "explicit-all") {
    sourceManifest.bundledDependencies = true;
  }
  writeJsonFile(join(packageDir, "package.json"), sourceManifest);
  writeFileText(
    join(packageDir, "dist", "index.js"),
    bundling === "range-policy"
      ? 'import dep from "local-runtime-dep"; export default dep.value; export const sibling = dep.child;\n'
      : 'export { default } from "local-runtime-dep";\n' +
          (bundling.startsWith("nested-")
            ? 'export { default as sibling } from "unpatched-sibling";\n'
            : ""),
  );
  writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
  let installedDir = join(repoDir, "node_modules", "local-runtime-dep");
  writeJsonFile(join(installedDir, "package.json"), {
    name: "local-runtime-dep",
    version: "1.0.0",
    main: "index.js",
    ...(bundling === "range-policy"
      ? { optionalDependencies: { "unpatched-sibling": "^1.0.0" } }
      : {}),
    ...(bundling === "skipped-optional"
      ? { os: [process.platform === "win32" ? "darwin" : "win32"] }
      : {}),
    ...(bundling === "dev-engine"
      ? { devEngines: { packageManager: { name: "pnpm", version: "11.9.0", onFail: "error" } } }
      : {}),
  });
  const installedSource =
    bundling === "range-policy"
      ? 'module.exports = {value: 2, child: require("unpatched-sibling")};\n'
      : "module.exports = 2;\n";
  writeFileText(join(installedDir, "index.js"), installedSource);
  const patch = `--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+${installedSource}`;
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const patchKey = "local-runtime-dep@1.0.0";
  const patchedVersion = `1.0.0(patch_hash=${patchHash})`;
  writeFileText(join(repoDir, "patches", "runtime.patch"), patch);
  writeJsonFile(join(repoDir, "pnpm-workspace.yaml"), {
    patchedDependencies: { [patchKey]: "patches/runtime.patch" },
  });
  const lock = {
    lockfileVersion: "9.0",
    patchedDependencies: { [patchKey]: patchHash },
    importers: {
      "extensions/diffs": {
        [optionalDirect ? "optionalDependencies" : "dependencies"]: {
          "local-runtime-dep": {
            specifier: "1.0.0",
            version: patchedVersion,
          },
        },
      },
    },
    packages: Object.fromEntries(
      registryVersions.map(({ manifest, integrity }) => [
        `${manifest.name}@${manifest.version}`,
        { resolution: { integrity } },
      ]),
    ),
    snapshots: {
      [`local-runtime-dep@${patchedVersion}`]: {},
      ...(bundling.startsWith("nested-")
        ? {
            "unpatched-sibling@1.0.0": {
              optionalDependencies: {
                "local-runtime-dep": bundling === "nested-other" ? "2.0.0" : "1.0.0",
              },
            },
          }
        : {}),
    },
  };
  writeJsonFile(join(repoDir, "pnpm-lock.yaml"), lock);
  writeJsonFile(join(repoDir, "node_modules", ".pnpm", "lock.yaml"), lock);
  writeJsonFile(join(repoDir, "node_modules", ".modules.yaml"), {
    nodeLinker: "hoisted",
    virtualStoreDir: ".pnpm",
    hoistedLocations: {
      [`local-runtime-dep@${patchedVersion}`]: ["node_modules/local-runtime-dep"],
    },
  });
  if (bundling.startsWith("isolated")) {
    const virtualStoreDirMaxLength = bundling === "isolated-short" ? 60 : 120;
    const filename = `local-runtime-dep@1.0.0_patch_hash=${patchHash}`;
    const slot =
      virtualStoreDirMaxLength === 60
        ? `${filename.slice(0, 27)}_${createHash("sha256").update(filename).digest("hex").slice(0, 32)}`
        : filename;
    const isolatedDir = join(
      repoDir,
      "node_modules",
      ".pnpm",
      slot,
      "node_modules",
      "local-runtime-dep",
    );
    mkdirSync(dirname(isolatedDir), { recursive: true });
    renameSync(installedDir, isolatedDir);
    installedDir = isolatedDir;
    mkdirSync(join(packageDir, "node_modules"), { recursive: true });
    symlinkSync(
      installedDir,
      join(packageDir, "node_modules", "local-runtime-dep"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeJsonFile(join(repoDir, "node_modules", ".modules.yaml"), {
      nodeLinker: "isolated",
      virtualStoreDir: ".pnpm",
      virtualStoreDirMaxLength,
    });
  }
  for (const yamlPath of [
    join(repoDir, "pnpm-workspace.yaml"),
    join(repoDir, "node_modules", ".modules.yaml"),
  ]) {
    writeFileSync(yamlPath, `---\n${readFileSync(yamlPath, "utf8")}`);
  }
  return {
    repoDir,
    packageDir,
    sourceManifest,
    installedDir,
    installedSource,
    registryVersions,
    lock,
  };
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

  it.for([
    { name: "module", partial: undefined },
    { name: "env-only", partial: {} },
    { name: "missing exportName", partial: { specifier: "./absent-probe" } },
    { name: "blank exportName", partial: { specifier: "./absent-probe", exportName: " \t" } },
    { name: "missing specifier", partial: { exportName: "hasState" } },
    { name: "blank specifier", partial: { specifier: " \t", exportName: "hasState" } },
  ])(
    "packs and loads both channel-state probes from one package artifact ($name)",
    ({ partial }) => {
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
      if (partial) {
        for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
          sourcePackageJson.openclaw.channel[metadataKey] = {
            ...partial,
            env: { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] },
          };
        }
      }
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
        const stagedPackageJson = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
        expect(stagedPackageJson.openclaw.channel.configuredState).toEqual(
          partial
            ? sourcePackageJson.openclaw.channel.configuredState
            : {
                specifier: "./dist/configured-state.cjs",
                exportName: "hasConfiguredChannelState",
              },
        );
        expect(stagedPackageJson.openclaw.channel.persistedAuthState).toEqual(
          partial
            ? sourcePackageJson.openclaw.channel.persistedAuthState
            : {
                specifier: "./dist/auth-presence.cjs",
                exportName: "hasPersistedChannelAuth",
              },
        );

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
        const packedPackage = parseNpmPackResult(pack.stdout);
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
        if (partial) {
          const channel = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
            .openclaw.channel;
          expect(channel).toEqual(sourcePackageJson.openclaw.channel);
          for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
            const probe = {
              entry: {
                channel,
                pluginId: "diffs",
                rootDir: packageRoot,
                origin: "global" as const,
              },
              metadataKey,
              cfg: {},
            };
            expect(hasChannelPackageState({ ...probe, env: {} })).toBe(false);
            expect(
              hasChannelPackageState({
                ...probe,
                env: { SYNTHETIC_PLUGIN_TOKEN: "synthetic-test-value" },
              }),
            ).toBe(true);
          }
          return;
        }
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
      for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
        writeJsonFile(join(packageDir, "package.json"), {
          ...sourcePackageJson,
          openclaw: {
            ...sourcePackageJson.openclaw,
            channel: {
              id: "diffs",
              [metadataKey]: {
                env: { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] },
                specifier: "./missing-state",
                exportName: "hasState",
              },
            },
          },
        });
        expect(() =>
          withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
            throw new Error("missing module output reached pack callback");
          }),
        ).toThrow(
          `channel ${metadataKey} specifier './missing-state' has no runtime output for diffs`,
        );
      }
    },
  );

  it.each(["default destination", "relative destination", "split destination", "failed command"])(
    "preserves source dependencies while staging npm bundles with %s",
    (scenario) => {
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
        dependencies: { "local-runtime-dep": "file:./deps/local-runtime-dep" },
        devDependencies: { "@openclaw/plugin-sdk": "workspace:*" },
        openclaw: {
          extensions: ["./index.ts"],
          setupEntry: "./setup-entry.ts",
          compat: { pluginApi: ">=2026.4.30" },
          release: { publishToNpm: true },
        },
      });
      const sourceDependencyPath = join(
        packageDir,
        "node_modules",
        "local-runtime-dep",
        "package.json",
      );
      const sourceVersion = '{"name":"local-runtime-dep","version":"9.0.0"}\n';
      writeFileText(sourceDependencyPath, sourceVersion);
      const sourceOnlyPath = join(packageDir, "node_modules", "source-only", "marker");
      writeFileText(sourceOnlyPath, "keep\n");
      const originalText = readFileSync(join(packageDir, "package.json"), "utf8");
      const outputDir =
        scenario.includes("destination") && scenario !== "default destination"
          ? join(packageDir, "artifacts")
          : packageDir;
      mkdirSync(outputDir, { recursive: true });
      const command =
        scenario === "failed command"
          ? [process.execPath, "-e", "console.log(process.cwd()); process.exit(7);"]
          : [
              "npm",
              "pack",
              "--json",
              "--ignore-scripts",
              ...(scenario === "relative destination"
                ? ["--pack-destination=artifacts"]
                : scenario === "split destination"
                  ? ["--pack-destination", "artifacts"]
                  : []),
            ];
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          tsxImport,
          fileURLToPath(new URL("../scripts/lib/plugin-npm-package-manifest.mts", import.meta.url)),
          "--run",
          packageDir,
          "--",
          ...command,
        ],
        {
          cwd: repoDir,
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1" },
        },
      );
      expect(result.status, result.stderr).toBe(scenario === "failed command" ? 7 : 0);
      expect(readFileSync(sourceDependencyPath, "utf8")).toBe(sourceVersion);
      expect(readFileSync(sourceOnlyPath, "utf8")).toBe("keep\n");
      expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
      expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalText);
      if (scenario === "failed command") {
        const stagingDir = result.stdout.trim();
        expect(stagingDir).not.toBe("");
        expect(stagingDir).not.toBe(packageDir);
        expect(existsSync(stagingDir)).toBe(false);
        return;
      }
      const packed = parseNpmPackResult(result.stdout);
      const tarball = join(outputDir, packed.filename);
      expect(existsSync(tarball)).toBe(true);
      const files = packed.files.map((entry) => entry.path);
      expect(files).toContain("node_modules/local-runtime-dep/package.json");
      expect(files).toContain("node_modules/optional-platform-dep/package.json");
      expect(files.some((file) => file.includes("source-only"))).toBe(false);
      expect(files).not.toContain("package-lock.json");
      expect(files).not.toContain("npm-shrinkwrap.json");
      const extract = (file: string) => {
        const extraction = spawnSync("tar", ["-xOf", tarball, `package/${file}`], {
          encoding: "utf8",
        });
        expect(extraction.status, extraction.stderr).toBe(0);
        return JSON.parse(extraction.stdout);
      };
      const manifest = extract("package.json");
      expect(manifest.bundledDependencies).toEqual(["local-runtime-dep"]);
      expect(manifest.devDependencies).toBeUndefined();
      expect(extract("node_modules/local-runtime-dep/package.json").version).toBe("1.0.0");
    },
  );

  it.each([
    "default",
    "isolated",
    "isolated-short",
    "partial",
    "all",
    "clawhub",
    "optional-direct",
    "nested-other",
    "nested-same",
    "explicit-all",
    "unchanged",
    "skipped-optional",
    "dev-engine",
    "range-policy",
  ])("preserves patched dependency packaging contracts (%s)", async (bundling) => {
    const { repoDir, packageDir, sourceManifest, installedDir, installedSource, registryVersions } =
      writePatchedRuntimeFixture(bundling);
    if (bundling === "unchanged") {
      delete sourceManifest.openclaw.setupEntry;
      writeJsonFile(join(packageDir, "package.json"), sourceManifest);
      Object.assign(
        sourceManifest,
        resolveAugmentedPluginNpmPackageJson({
          repoRoot: repoDir,
          packageDir,
          bundleDependencies: true,
        }).packageJson,
        { bundledDependencies: ["local-runtime-dep"] },
      );
      writeJsonFile(join(packageDir, "package.json"), sourceManifest);
    }
    const consumerDir = join(repoDir, "consumer");
    mkdirSync(consumerDir);
    const originalManifest = readFileSync(join(packageDir, "package.json"), "utf8");
    const server = createServer((request, response) => {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const versions = registryVersions.filter(
        ({ manifest }) => request.url === `/${manifest.name}`,
      );
      const tarball = registryVersions.find(
        ({ manifest }) => request.url === `/${manifest.name}-${manifest.version}.tgz`,
      );
      if (versions.length > 0) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: versions[0]?.manifest.name,
            "dist-tags": { latest: versions.at(-1)?.manifest.version },
            versions: Object.fromEntries(
              versions.map(({ manifest, integrity }) => [
                manifest.version,
                {
                  ...manifest,
                  dist: {
                    tarball: `${endpoint}/${manifest.name}-${manifest.version}.tgz`,
                    integrity,
                  },
                },
              ]),
            ),
          }),
        );
      } else if (tarball) {
        response.end(tarball.tarball);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const registryEnv = {
      ...process.env,
      npm_config_registry: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      npm_config_cache: join(repoDir, "npm-cache"),
    };
    try {
      let packResult: NpmPackResult;
      if (bundling === "clawhub") {
        const cli = join(repoDir, "clawhub.cjs");
        const metadata = join(consumerDir, "pack-metadata.json");
        writeFileText(
          cli,
          `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const source = args[args.indexOf("pack") + 1];
const destination = args[args.indexOf("--pack-destination") + 1];
const stdout = execFileSync("npm", ["pack", source, "--json", "--ignore-scripts", "--pack-destination", destination], { encoding: "utf8" });
fs.writeFileSync(${JSON.stringify(metadata)}, stdout);
const output = JSON.parse(stdout);
const [packed] = Array.isArray(output) ? output : Object.values(output);
console.log(JSON.stringify({ path: path.join(destination, packed.filename) }));
`,
        );
        chmodSync(cli, 0o700);
        const env: NodeJS.ProcessEnv = {
          ...registryEnv,
          SOURCE_COMMIT: "1".repeat(40),
          SOURCE_REF: "fixture",
          OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
          OPENCLAW_CLAWHUB_CLI: cli,
          OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: consumerDir,
        };
        delete env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT;
        await execFileAsync(
          "bash",
          [
            fileURLToPath(new URL("../scripts/plugin-clawhub-publish.sh", import.meta.url)),
            "--pack",
            "extensions/diffs",
          ],
          { cwd: repoDir, encoding: "utf8", env },
        );
        packResult = parseNpmPackResult(readFileSync(metadata, "utf8"));
      } else {
        const packing = execFileAsync(
          process.execPath,
          [
            "--import",
            tsxImport,
            fileURLToPath(
              new URL("../scripts/lib/plugin-npm-package-manifest.mts", import.meta.url),
            ),
            "--run",
            packageDir,
            "--",
            ...(bundling === "range-policy"
              ? [
                  process.execPath,
                  "--input-type=module",
                  "-e",
                  'const m = await import("./dist/index.js"); console.log(JSON.stringify([m.default, m.sibling]));',
                ]
              : ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", consumerDir]),
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: {
              ...registryEnv,
              OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: repoDir,
              OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES:
                bundling === "all" || bundling.startsWith("nested-") ? "1" : "0",
            },
          },
        );
        if (bundling === "skipped-optional") {
          await expect(packing).rejects.toThrow("patched runtime dependency was not installed");
          return;
        }
        const packed = await packing;
        if (bundling === "range-policy") {
          expect(JSON.parse(packed.stdout)).toEqual([2, 3]);
          return;
        }
        packResult = parseNpmPackResult(packed.stdout);
      }
      const extracted = spawnSync(
        "tar",
        ["-xzf", join(consumerDir, packResult.filename), "-C", consumerDir],
        { encoding: "utf8" },
      );
      expect(extracted.status, extracted.stderr).toBe(0);
      const consumerPackage = join(consumerDir, "package");
      const expectedSibling =
        bundling === "nested-other" ? 20 : bundling === "nested-same" ? 2 : null;
      if (bundling.startsWith("nested-")) {
        const bundled = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'const m = await import("./dist/index.js"); console.log(JSON.stringify([m.default, m.sibling]));',
          ],
          { cwd: consumerPackage, encoding: "utf8" },
        );
        expect(bundled.status, bundled.stderr).toBe(0);
        expect(JSON.parse(bundled.stdout)).toEqual([2, expectedSibling]);
      }
      const npm = resolvePluginNpmCommand([
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--workspaces=false",
        "--no-audit",
        "--no-fund",
      ]);
      await execFileAsync(npm.command, npm.args, {
        cwd: consumerPackage,
        encoding: "utf8",
        ...npm,
        env: { ...registryEnv, ...npm.env },
      });
      const loaded = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const m = await import("./dist/index.js"); console.log(JSON.stringify([m.default, m.sibling]));',
        ],
        { cwd: consumerPackage, encoding: "utf8" },
      );
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(JSON.parse(loaded.stdout)).toEqual([2, expectedSibling]);
      const published = JSON.parse(readFileSync(join(consumerPackage, "package.json"), "utf8"));
      expect(published.dependencies).toEqual(sourceManifest.dependencies);
      expect(published.optionalDependencies).toEqual(sourceManifest.optionalDependencies);
      expect(published.bundledDependencies).toEqual(
        ["partial", "all", "explicit-all"].includes(bundling) || bundling.startsWith("nested-")
          ? ["local-runtime-dep", "unpatched-sibling"]
          : ["local-runtime-dep"],
      );
      expect(packResult.files.some(({ path }) => path.endsWith(".tgz"))).toBe(false);
      expect(readFileSync(join(installedDir, "index.js"), "utf8")).toBe(installedSource);
      expect(readFileSync(join(packageDir, "package.json"), "utf8")).toBe(originalManifest);
      expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(
    ["default", "isolated"].flatMap((layout) =>
      ["bundle opt-out", "stale install", "stale importer spec", "wrong package identity"].map(
        (scenario) => ({ layout, scenario }),
      ),
    ),
  )(
    "rejects a patched artifact when its packaging precondition fails ($layout / $scenario)",
    ({ layout, scenario }) => {
      const { repoDir, packageDir, sourceManifest, installedDir, lock } =
        writePatchedRuntimeFixture(layout);
      if (scenario === "bundle opt-out") {
        sourceManifest.openclaw.release.bundleRuntimeDependencies = false;
        writeJsonFile(join(packageDir, "package.json"), sourceManifest);
      } else if (scenario === "stale install") {
        writeJsonFile(join(repoDir, "node_modules", ".pnpm", "lock.yaml"), {
          ...lock,
          patchedDependencies: {},
        });
      } else if (scenario === "stale importer spec") {
        lock.importers["extensions/diffs"].dependencies = {
          "local-runtime-dep": { specifier: "2.0.0", version: "2.0.0" },
        };
        writeJsonFile(join(repoDir, "pnpm-lock.yaml"), lock);
      } else {
        writeJsonFile(join(installedDir, "package.json"), {
          name: "local-runtime-dep",
          version: "2.0.0",
        });
      }
      expect(() =>
        withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
          throw new Error("unsafe artifact reached pack callback");
        }),
      ).toThrow(
        scenario === "bundle opt-out"
          ? "bundleRuntimeDependencies=false"
          : scenario === "stale install"
            ? "matching frozen pnpm install"
            : scenario === "stale importer spec"
              ? "frozen pnpm importer"
              : "identity mismatch",
      );
      expect(readFileSync(join(installedDir, "index.js"), "utf8")).toBe("module.exports = 2;\n");
    },
  );

  it.each(["foreign target", "redirected slot", "unpatched slot"])(
    "rejects an isolated package link outside its frozen patched slot (%s)",
    (scenario) => {
      const { repoDir, packageDir, installedDir } = writePatchedRuntimeFixture("isolated");
      const target =
        scenario === "unpatched slot"
          ? join(
              repoDir,
              "node_modules",
              ".pnpm",
              "local-runtime-dep@1.0.0",
              "node_modules",
              "local-runtime-dep",
            )
          : join(repoDir, "foreign-runtime");
      mkdirSync(dirname(target), { recursive: true });
      renameSync(installedDir, target);
      const link =
        scenario === "redirected slot"
          ? installedDir
          : join(packageDir, "node_modules", "local-runtime-dep");
      rmSync(link, { force: true });
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      expect(() =>
        withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, () => {
          throw new Error("unsafe artifact reached pack callback");
        }),
      ).toThrow("not the frozen pnpm package");
    },
  );

  it("does not require a patch registered for a different resolved dependency version", () => {
    const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-unpatched-version-");
    const packageDir = writePublishablePluginPackage(repoDir);
    writeFileText(join(packageDir, "dist", "index.js"), "export {};\n");
    writeFileText(join(packageDir, "dist", "setup-entry.js"), "export {};\n");
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    packageJson.dependencies = { "local-runtime-dep": "2.0.0" };
    writeJsonFile(join(packageDir, "package.json"), packageJson);
    writeJsonFile(join(repoDir, "pnpm-workspace.yaml"), {
      patchedDependencies: { "local-runtime-dep@1.0.0": "patches/old.patch" },
    });
    writeJsonFile(join(repoDir, "pnpm-lock.yaml"), {
      importers: {
        "extensions/diffs": {
          dependencies: { "local-runtime-dep": { specifier: "2.0.0", version: "2.0.0" } },
        },
      },
    });
    withAugmentedPluginNpmManifestForPackage({ repoRoot: repoDir, packageDir }, (context) => {
      expect(context.packageDir).toBe(packageDir);
      expect(
        JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bundledDependencies,
      ).toBeUndefined();
    });
    expect(existsSync(join(repoDir, "node_modules"))).toBe(false);
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
