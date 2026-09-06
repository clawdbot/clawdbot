// Covers managed plugin install path generation.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginGitDir,
  resolveDefaultPluginNpmDir,
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store-path.js";

describe("plugin install root context", () => {
  it("keeps discovery roots on the operator install while runtime state is redirected", async () => {
    const operatorRoots = resolvePluginInstallRoots(
      { OPENCLAW_STATE_DIR: "/operator/openclaw" },
      () => "/unused-home",
    );
    const redirectedEnv = { OPENCLAW_STATE_DIR: "/tmp/ephemeral-run" };

    await withPluginInstallRoots(operatorRoots, async () => {
      await Promise.resolve();
      expect(resolveDefaultPluginExtensionsDir(redirectedEnv)).toBe(
        "/operator/openclaw/extensions",
      );
      expect(resolveDefaultPluginNpmDir(redirectedEnv)).toBe("/operator/openclaw/npm");
      expect(resolveDefaultPluginGitDir(redirectedEnv)).toBe("/operator/openclaw/git");
      expect(resolveInstalledPluginIndexStorePath({ env: redirectedEnv })).toBe(
        "/operator/openclaw/state/openclaw.sqlite",
      );
      expect(
        resolveInstalledPluginIndexStateDatabaseOptions({ env: redirectedEnv }).env
          ?.OPENCLAW_STATE_DIR,
      ).toBe("/operator/openclaw");
    });

    expect(resolveDefaultPluginExtensionsDir(redirectedEnv)).toBe("/tmp/ephemeral-run/extensions");
    expect(resolveInstalledPluginIndexStorePath({ env: redirectedEnv })).toBe(
      "/tmp/ephemeral-run/state/openclaw.sqlite",
    );
    expect(
      resolveInstalledPluginIndexStateDatabaseOptions({ env: redirectedEnv }).env
        ?.OPENCLAW_STATE_DIR,
    ).toBe("/tmp/ephemeral-run");
  });

  it("isolates concurrent install-root scopes", async () => {
    const resolveScopedRoot = async (stateDir: string) => {
      const roots = resolvePluginInstallRoots({ OPENCLAW_STATE_DIR: stateDir });
      return await withPluginInstallRoots(roots, async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        return resolveDefaultPluginExtensionsDir({ OPENCLAW_STATE_DIR: "/redirected" });
      });
    };

    await expect(
      Promise.all([resolveScopedRoot("/operator/one"), resolveScopedRoot("/operator/two")]),
    ).resolves.toEqual(["/operator/one/extensions", "/operator/two/extensions"]);
  });
});

describe("managed npm plugin install paths", () => {
  it("keeps generation project names compact for nested Windows runtime binaries", () => {
    const packageName = "@openclaw/codex";
    const generationKey = [
      packageName,
      "2026.6.10",
      `${packageName}@2026.6.10`,
      "sha512-test-integrity",
      "codexshasum",
    ].join("\n");
    const projectDir = resolvePluginNpmGenerationProjectDir({
      npmDir: String.raw`C:\Users\Administrator\.openclaw\npm`,
      packageName,
      generationKey,
    });
    const projectName = path.basename(projectDir);

    expect(projectName).toMatch(
      /^openclaw-codex-[a-f0-9]{10}__openclaw-generation__g-[a-f0-9]{16}$/u,
    );
    expect(projectName.length).toBeLessThanOrEqual(66);

    const nestedCodexBinaryPath = path.win32.join(
      String.raw`C:\Users\Administrator\.openclaw\npm\projects`,
      projectName,
      "node_modules",
      "@openclaw",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    expect(nestedCodexBinaryPath.length).toBeLessThan(260);
  });

  it("keeps generation project names under the recoverable package prefix", () => {
    const packageName = "@openclaw/codex";
    const projectDir = resolvePluginNpmGenerationProjectDir({
      npmDir: "/tmp/openclaw/npm",
      packageName,
      generationKey: "codex-v2",
    });

    expect(path.basename(projectDir)).toMatch(
      new RegExp(
        `^${path.basename(resolvePluginNpmProjectDir({ npmDir: "/tmp/openclaw/npm", packageName }))}__openclaw-generation__`,
        "u",
      ),
    );
  });
});
