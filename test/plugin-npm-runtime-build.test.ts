// Plugin npm runtime build tests validate plugin runtime package builds.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPluginNpmRuntime,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "../scripts/lib/plugin-npm-runtime-build.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

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
        plan.packageJson.openclaw.compat.pluginApi,
      );
      expect(plan.packagePeerMetadata.peerDependenciesMeta.openclaw.optional).toBe(true);
    }
  });

  it("includes top-level public runtime surfaces and root-build-excluded plugins", () => {
    const qqbotPlan = resolvePluginNpmRuntimeBuildPlan({
      repoRoot,
      packageDir: path.join(repoRoot, "extensions", "qqbot"),
    });
    const qqbotRuntimePlan = expectPluginNpmRuntimeBuildPlan(qqbotPlan);
    expect(qqbotRuntimePlan.entry).toEqual({
      api: path.join(repoRoot, "extensions", "qqbot", "api.ts"),
      "channel-entry-api": path.join(repoRoot, "extensions", "qqbot", "channel-entry-api.ts"),
      "channel-plugin-api": path.join(repoRoot, "extensions", "qqbot", "channel-plugin-api.ts"),
      "doctor-contract-api": path.join(repoRoot, "extensions", "qqbot", "doctor-contract-api.ts"),
      index: path.join(repoRoot, "extensions", "qqbot", "index.ts"),
      "runtime-api": path.join(repoRoot, "extensions", "qqbot", "runtime-api.ts"),
      "secret-contract-api": path.join(repoRoot, "extensions", "qqbot", "secret-contract-api.ts"),
      "setup-entry": path.join(repoRoot, "extensions", "qqbot", "setup-entry.ts"),
      "setup-plugin-api": path.join(repoRoot, "extensions", "qqbot", "setup-plugin-api.ts"),
      "tools-api": path.join(repoRoot, "extensions", "qqbot", "tools-api.ts"),
    });
    expect(qqbotRuntimePlan.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(qqbotRuntimePlan.runtimeSetupEntry).toBe("./dist/setup-entry.js");

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
      "npm-shrinkwrap.json",
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
});
