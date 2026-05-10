import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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
      "channel-plugin-api": path.join(repoRoot, "extensions", "qqbot", "channel-plugin-api.ts"),
      index: path.join(repoRoot, "extensions", "qqbot", "index.ts"),
      "runtime-api": path.join(repoRoot, "extensions", "qqbot", "runtime-api.ts"),
      "secret-contract-api": path.join(repoRoot, "extensions", "qqbot", "secret-contract-api.ts"),
      "setup-entry": path.join(repoRoot, "extensions", "qqbot", "setup-entry.ts"),
      "setup-plugin-api": path.join(repoRoot, "extensions", "qqbot", "setup-plugin-api.ts"),
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
      "README.md",
      "skills/**",
    ]);
  });
});
