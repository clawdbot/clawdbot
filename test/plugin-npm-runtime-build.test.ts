import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
} from "../scripts/lib/plugin-npm-runtime-build.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

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
    expect(plans.filter(Boolean).map((plan) => plan?.pluginDir)).toEqual(
      packageDirs.map((packageDir) => path.basename(packageDir)),
    );
    for (const plan of plans) {
      expect(plan?.outDir).toBe(path.join(plan?.packageDir ?? "", "dist"));
      expect(plan?.runtimeExtensions.every((entry) => entry.startsWith("./dist/"))).toBe(true);
      expect(plan?.runtimeBuildOutputs.every((entry) => entry.startsWith("./dist/"))).toBe(true);
      expect(plan?.packageFiles).toContain("dist/**");
      expect(plan?.packagePeerMetadata.peerDependencies.openclaw).toBe(
        plan?.packageJson.openclaw.compat.pluginApi,
      );
      expect(plan?.packagePeerMetadata.peerDependenciesMeta.openclaw.optional).toBe(true);
    }
  });

  it("includes top-level public runtime surfaces and root-build-excluded plugins", () => {
    const qqbotPlan = resolvePluginNpmRuntimeBuildPlan({
      repoRoot,
      packageDir: path.join(repoRoot, "extensions", "qqbot"),
    });
    expect(qqbotPlan?.entry).toEqual(
      expect.objectContaining({
        index: path.join(repoRoot, "extensions", "qqbot", "index.ts"),
        "runtime-api": path.join(repoRoot, "extensions", "qqbot", "runtime-api.ts"),
        "setup-entry": path.join(repoRoot, "extensions", "qqbot", "setup-entry.ts"),
      }),
    );
    expect(qqbotPlan?.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(qqbotPlan?.runtimeSetupEntry).toBe("./dist/setup-entry.js");

    const diffsPlan = resolvePluginNpmRuntimeBuildPlan({
      repoRoot,
      packageDir: path.join(repoRoot, "extensions", "diffs"),
    });
    expect(diffsPlan?.entry).toEqual(
      expect.objectContaining({
        api: path.join(repoRoot, "extensions", "diffs", "api.ts"),
        index: path.join(repoRoot, "extensions", "diffs", "index.ts"),
        "runtime-api": path.join(repoRoot, "extensions", "diffs", "runtime-api.ts"),
      }),
    );
    expect(diffsPlan?.packageFiles).toEqual([
      "dist/**",
      "openclaw.plugin.json",
      "README.md",
      "skills/**",
    ]);
  });
});
