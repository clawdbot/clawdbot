// Plugin npm runtime build tests validate plugin runtime package builds.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginNpmRuntime,
  listMissingPluginNpmRuntimeHostExports,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "../scripts/lib/plugin-npm-runtime-build.mts";
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
  it.each(["index.tsx", "src/index.tsx"])(
    "builds an executable %s package entry",
    async (entry) => {
      const packageDir = tempDirs.make("openclaw-plugin-runtime-tsx-");
      mkdirSync(path.dirname(path.join(packageDir, entry)), { recursive: true });
      writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@openclaw/tsx-fixture",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: [`./${entry}`], compat: { pluginApi: "1.0.0" } },
        }),
      );
      writeFileSync(
        path.join(packageDir, entry),
        'const id: string = "tsx-fixture"; export default { id };\n',
      );

      await buildPluginNpmRuntime({ repoRoot, packageDir, logLevel: "silent" });

      const outputPath = path.join(packageDir, "dist", entry.replace(/\.tsx$/u, ".js"));
      expect(existsSync(outputPath)).toBe(true);
      expect((await import(pathToFileURL(outputPath).href)).default.id).toBe("tsx-fixture");
    },
  );

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

  it("plans the Zalo public setup API with its lazy package surface", () => {
    const packageDir = path.join(repoRoot, "extensions", "zalo");
    const plan = expectPluginNpmRuntimeBuildPlan(
      resolvePluginNpmRuntimeBuildPlan({
        repoRoot,
        packageDir,
      }),
    );
    expect(plan.entry["setup-api"]).toBe(path.join(packageDir, "setup-api.ts"));
    expect(plan.entry["setup-surface"]).toBe(path.join(packageDir, "setup-surface.ts"));
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-api.js");
    expect(plan.runtimeBuildOutputs).toContain("./dist/setup-surface.js");
    expect(plan.runtimeBuildOutputs).not.toContain("./dist/src/setup-surface.js");
    expect(plan.packageFiles).toContain("dist/**");
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

  it("keeps published llama.cpp runtime imports resolvable from the host package", async () => {
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir: "extensions/llama-cpp",
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
