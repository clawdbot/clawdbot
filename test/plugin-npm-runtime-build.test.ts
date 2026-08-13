// Plugin npm runtime build tests validate plugin runtime package builds.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolvePluginNpmCommand,
  withAugmentedPluginNpmManifestForPackage,
} from "../scripts/lib/plugin-npm-package-manifest.mts";
import {
  buildPluginNpmRuntime,
  listMissingPluginNpmRuntimeHostExports,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "../scripts/lib/plugin-npm-runtime-build.mts";
import {
  createPluginModuleLoaderCache,
  getCachedPluginSourceModuleLoader,
} from "../src/plugins/plugin-module-loader-cache.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type PluginNpmRuntimeBuildPlan = NonNullable<ReturnType<typeof resolvePluginNpmRuntimeBuildPlan>>;

function expectDistRelativePaths(paths: string[]) {
  expect(paths.every((entry) => entry.startsWith("./dist/"))).toBe(true);
}

function expectPluginNpmRuntimeBuildPlan(
  plan: ReturnType<typeof resolvePluginNpmRuntimeBuildPlan>,
): PluginNpmRuntimeBuildPlan {
  if (!plan) {
    throw new Error("expected plugin npm runtime build plan");
  }
  return plan;
}

describe("plugin npm runtime build planning", () => {
  it("rejects a symlinked package dist root before building", async () => {
    const syntheticRepoRoot = tempDirs.make("openclaw-plugin-runtime-output-root-");
    const packageDir = path.join(syntheticRepoRoot, "extensions", "demo");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(syntheticRepoRoot, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/demo",
        version: "1.0.0",
        openclaw: {
          compat: { pluginApi: "1.0.0" },
          extensions: ["./index.ts"],
          release: { publishToNpm: true },
        },
      }),
    );
    writeFileSync(path.join(packageDir, "index.ts"), "export default {};\n");
    const targetDir = path.join(syntheticRepoRoot, "live-gateway-dist");
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
    symlinkSync(targetDir, path.join(packageDir, "dist"), "dir");

    await expect(
      buildPluginNpmRuntime({
        repoRoot: syntheticRepoRoot,
        packageDir,
        logLevel: "silent",
      }),
    ).rejects.toThrow(/symbolic link/u);
    expect(readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
    expect(readlinkSync(path.join(packageDir, "dist"))).toBe(targetDir);
  });

  it("plans package-local runtime entries for every publishable plugin package", () => {
    const packageDirs = listPublishablePluginPackageDirs({ repoRoot });
    expect(packageDirs.length).toBeGreaterThan(0);

    const plans = packageDirs.map((packageDir) =>
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir,
      }),
    );
    const resolvedPlans = plans.map(expectPluginNpmRuntimeBuildPlan);
    expect(resolvedPlans.map((plan) => plan.pluginDir)).toEqual(
      packageDirs.map((packageDir) => path.basename(packageDir)),
    );
    for (const plan of resolvedPlans) {
      expect(plan.outDir).toBe(path.join(plan.packageDir, "dist"));
      expectDistRelativePaths(plan.runtimeExtensions);
      expectDistRelativePaths(plan.runtimeBuildOutputs);
      expect(plan.packageFiles).toContain("dist/**");
      expect(plan.packagePeerMetadata.peerDependencies.openclaw).toBe(
        plan.packageJson.openclaw?.compat?.pluginApi,
      );
      expect(plan.packagePeerMetadata.peerDependenciesMeta.openclaw.optional).toBe(true);
    }
  });

  it("includes top-level public runtime surfaces", () => {
    const diffsPlan = resolvePluginNpmRuntimeBuildPlan({
      repoRoot,
      packageDir: path.join(repoRoot, "extensions", "diffs"),
    });
    const diffsRuntimePlan = expectPluginNpmRuntimeBuildPlan(diffsPlan);
    expect(diffsRuntimePlan.entry).toEqual({
      api: path.join(repoRoot, "extensions", "diffs", "api.ts"),
      index: path.join(repoRoot, "extensions", "diffs", "index.ts"),
      "runtime-api": path.join(repoRoot, "extensions", "diffs", "runtime-api.ts"),
    });
    expect(diffsRuntimePlan.packageFiles).toEqual([
      "dist/**",
      "openclaw.plugin.json",
      "README.md",
      "skills/**",
    ]);
  });

  it("builds doctor contract surfaces for publishable channel plugins", () => {
    for (const pluginDir of ["msteams", "nostr"]) {
      const plan = expectPluginNpmRuntimeBuildPlan(
        resolvePluginNpmRuntimeBuildPlan({
          repoRoot,
          packageDir: path.join(repoRoot, "extensions", pluginDir),
        }),
      );
      expect(plan.entry["doctor-contract-api"]).toBe(
        path.join(repoRoot, "extensions", pluginDir, "doctor-contract-api.ts"),
      );
      const extension = plan.runtimeFormat === "cjs" ? ".cjs" : ".js";
      expect(plan.runtimeBuildOutputs).toContain(`./dist/doctor-contract-api${extension}`);
      expect(plan.packageFiles).toContain("dist/**");
    }
  });

  it("plans msteams startup runtime surfaces as native CommonJS entrypoints", () => {
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "msteams"),
      }),
    );

    expect(plan.runtimeFormat).toBe("cjs");
    expect(plan.runtimeExtensions).toEqual(["./dist/index.cjs"]);
    expect(plan.runtimeSetupEntry).toBe("./dist/setup-entry.cjs");
    expect(plan.runtimeBuildOutputs).toEqual(
      expect.arrayContaining([
        "./dist/channel-plugin-api.cjs",
        "./dist/doctor-contract-api.cjs",
        "./dist/index.cjs",
        "./dist/runtime-api.cjs",
        "./dist/secret-contract-api.cjs",
        "./dist/setup-entry.cjs",
        "./dist/setup-plugin-api.cjs",
      ]),
    );
  });

  it("builds msteams startup runtime surfaces as CommonJS files", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/msteams",
      logLevel: "silent",
    });
    const plan = expectPluginNpmRuntimeBuildPlan(result);

    expect(plan.runtimeFormat).toBe("cjs");
    expect(plan.runtimeExtensions).toEqual(["./dist/index.cjs"]);
    expect(plan.runtimeSetupEntry).toBe("./dist/setup-entry.cjs");

    const entrypoints = [
      "dist/index.cjs",
      "dist/channel-plugin-api.cjs",
      "dist/runtime-api.cjs",
      "dist/setup-plugin-api.cjs",
      "dist/secret-contract-api.cjs",
    ];
    const missing = entrypoints.filter(
      (relativePath) => !existsSync(path.join(repoRoot, "extensions/msteams", relativePath)),
    );
    expect(missing).toEqual([]);

    for (const relativePath of entrypoints) {
      const text = readFileSync(path.join(repoRoot, "extensions/msteams", relativePath), "utf8");
      expect(text).not.toMatch(/^import\s/u);
      expect(text).toMatch(/(?:require\(|exports\.)/u);
    }

    const indexText = readFileSync(
      path.join(repoRoot, "extensions/msteams/dist/index.cjs"),
      "utf8",
    );
    expect(indexText).toContain('specifier: "./channel-plugin-api.cjs"');
    expect(indexText).toContain('specifier: "./secret-contract-api.cjs"');
    expect(indexText).toContain('specifier: "./runtime-api.cjs"');

    const setupEntryText = readFileSync(
      path.join(repoRoot, "extensions/msteams/dist/setup-entry.cjs"),
      "utf8",
    );
    expect(setupEntryText).toContain('specifier: "./setup-plugin-api.cjs"');
    expect(setupEntryText).toContain('specifier: "./secret-contract-api.cjs"');
  });

  it("builds Tencent setup metadata for installed-package migrations", () => {
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "tencent"),
      }),
    );

    expect(plan.entry["setup-api"]).toBe(
      path.join(repoRoot, "extensions", "tencent", "setup-api.ts"),
    );
    expect(plan.runtimeSetupEntry).toBe("./dist/setup-api.js");
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-api.js");
  });

  it("packs the Zalo public setup API with its lazy runtime surface", async () => {
    const packageDir = path.join(repoRoot, "extensions", "zalo");
    const plan = expectPluginNpmRuntimeBuildPlan(
      await buildPluginNpmRuntime({
        repoRoot,
        packageDir,
        logLevel: "silent",
      }),
    );
    const consumerDir = tempDirs.make("openclaw-zalo-packed-setup-");
    let packedFiles: string[] = [];
    let setupApiPath = "";

    withAugmentedPluginNpmManifestForPackage(
      { repoRoot, packageDir, bundleDependencies: false },
      () => {
        const invocation = resolvePluginNpmCommand([
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          consumerDir,
        ]);
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
        expect(pack.status, pack.stderr).toBe(0);
        const [packedPackage] = JSON.parse(pack.stdout) as [
          { filename: string; files: Array<{ path: string }> },
        ];
        packedFiles = packedPackage.files.map((file) => file.path);
        const extract = spawnSync(
          "tar",
          ["-xzf", path.join(consumerDir, packedPackage.filename), "-C", consumerDir],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        expect(extract.status, extract.stderr).toBe(0);
        setupApiPath = path.join(consumerDir, "package", "dist", "setup-api.js");
      },
    );

    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-api.js");
    const loadSetupApi = getCachedPluginSourceModuleLoader({
      cache: createPluginModuleLoaderCache(),
      modulePath: setupApiPath,
      importerUrl: import.meta.url,
      devSourceRoot: repoRoot,
    });
    const setupApi = loadSetupApi(setupApiPath) as {
      zaloSetupWizard: { channel: string };
    };
    expect(setupApi.zaloSetupWizard.channel).toBe("zalo");
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-surface.js");
    expect(plan.runtimeBuildOutputs).not.toContain("./dist/src/setup-surface.js");
    expect(packedFiles).toContain("dist/setup-surface.js");
    expect(packedFiles).not.toContain("dist/src/setup-surface.js");
  });

  it("keeps published Codex runtime imports resolvable from the host package", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/codex",
      logLevel: "silent",
    });
    const plan = expectPluginNpmRuntimeBuildPlan(result);

    expect(listMissingPluginNpmRuntimeHostExports(plan)).toEqual([]);
  });

  it("detects unresolved side-effect host imports in built plugin runtimes", () => {
    const outDir = tempDirs.make("openclaw-plugin-runtime-host-import-");
    writeFileSync(
      path.join(outDir, "index.js"),
      [
        'import "openclaw/plugin-sdk/not-exported";',
        'const runtime = __require("openclaw/plugin-sdk/not-exported-from-require");',
        "void runtime;",
        "",
      ].join("\n"),
    );
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "codex"),
      }),
    );

    expect(listMissingPluginNpmRuntimeHostExports({ ...plan, outDir })).toEqual([
      "openclaw/plugin-sdk/not-exported",
      "openclaw/plugin-sdk/not-exported-from-require",
    ]);
  });

  it("does not require host metadata when the runtime has no host imports", () => {
    const syntheticRepoRoot = tempDirs.make("openclaw-plugin-runtime-synthetic-repo-");
    const outDir = tempDirs.make("openclaw-plugin-runtime-no-host-import-");
    writeFileSync(path.join(outDir, "index.js"), "export default {};\n");
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir: path.join(repoRoot, "extensions", "codex"),
      }),
    );

    expect(
      listMissingPluginNpmRuntimeHostExports({ ...plan, repoRoot: syntheticRepoRoot, outDir }),
    ).toEqual([]);
  });
});
