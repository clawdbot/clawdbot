import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as pluginRegistry from "../plugins/plugin-registry.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runPluginInstallCommand } from "./plugins-install-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("marketplace install persistence", () => {
  let stateDir: string;
  let marketplace: string;
  let configPath: string;
  let targetDir: string;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    const root = tempDirs.make("openclaw-marketplace-compensation-");
    stateDir = path.join(root, "state");
    marketplace = path.join(root, "marketplace");
    configPath = path.join(stateDir, "openclaw.json");
    targetDir = path.join(stateDir, "extensions", "demo");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const sourceDir = path.join(marketplace, "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    createColdPluginFixture({
      rootDir: sourceDir,
      pluginId: "demo",
      manifest: {
        configSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          additionalProperties: false,
        },
      },
    });
    await fs.writeFile(
      path.join(marketplace, "marketplace.json"),
      JSON.stringify({ name: "fixture", plugins: [{ name: "demo", source: "./demo" }] }),
    );
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const install = () =>
    runPluginInstallCommand({
      raw: "demo",
      opts: { marketplace, force: true, acceptCapabilities: true },
      allowInstallPolicyWarningPrompt: false,
      invalidateRuntimeCache: false,
      runtime,
    });

  it("removes the published payload and reports invalid configured settings", async () => {
    const config = JSON.stringify({ plugins: { entries: { demo: { config: { count: "old" } } } } });
    await fs.writeFile(configPath, config);

    const installed = install();
    await expect.soft(installed).resolves.toBeUndefined();
    expect.soft(runtime.exit).toHaveBeenCalledWith(1);
    expect
      .soft(runtime.error)
      .toHaveBeenCalledWith(expect.stringContaining("invalid configured settings"));
    await expect.soft(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.dirname(targetDir))).toEqual([]);
    expect(await loadInstalledPluginIndexInstallRecords()).toEqual({});
    expect(await fs.readFile(configPath, "utf8")).toBe(config);
  });

  it.each(["none", "refresh-warning", "after-commit"])(
    "retains committed files and provenance with fault=%s",
    async (fault) => {
      await fs.writeFile(configPath, "{}");
      if (fault === "refresh-warning") {
        vi.spyOn(pluginRegistry, "refreshPluginRegistry").mockRejectedValueOnce(
          new Error("refresh unavailable"),
        );
      }
      if (fault === "after-commit") {
        runtime.log.mockImplementation((message: string) => {
          if (message === "Installed plugin: demo") {
            throw new Error("success reporting failed");
          }
        });
      }

      await install();

      if (fault === "after-commit") {
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith("success reporting failed");
      } else {
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
      }
      await expect(fs.readFile(path.join(targetDir, "package.json"), "utf8")).resolves.toContain(
        '"1.0.0"',
      );
      expect((await loadInstalledPluginIndexInstallRecords()).demo).toMatchObject({
        source: "marketplace",
        installPath: targetDir,
        version: "1.0.0",
        marketplaceName: "fixture",
        marketplaceSource: marketplace,
        marketplacePlugin: "demo",
      });
      expect(JSON.parse(await fs.readFile(configPath, "utf8")).plugins.entries.demo.enabled).toBe(
        true,
      );
      expect(runtime.log).toHaveBeenCalledWith("Installed plugin: demo");
      if (fault === "refresh-warning") {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Plugin registry refresh failed: refresh unavailable"),
        );
      }
    },
  );
});
