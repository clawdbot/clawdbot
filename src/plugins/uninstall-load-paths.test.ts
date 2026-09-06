import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import { applyPluginUninstallDirectoryRemoval, planPluginUninstall } from "./uninstall.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin uninstall load-path lifecycle", () => {
  it.each(["package", "entry"])(
    "removes the owned %s alias before deletion and preserves later config edits",
    async (aliasTarget) => {
      const root = await fs.realpath(tempDirs.make("openclaw-uninstall-alias-"));
      const sourcePath = path.join(root, "source");
      const extensionsDir = path.join(root, "extensions");
      const installPath = path.join(extensionsDir, "demo");
      const entryPath = path.join(installPath, "index.js");
      const aliasPath = path.join(root, "alias");
      const unrelatedPath = path.join(root, "unrelated");
      const addedPath = path.join(root, "added");
      await Promise.all(
        [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      await fs.writeFile(entryPath, "export default {};\n");
      await fs.symlink(
        aliasTarget === "package" ? installPath : entryPath,
        aliasPath,
        aliasTarget === "package" ? "dir" : "file",
      );
      const config: OpenClawConfig = {
        plugins: {
          entries: { demo: { enabled: true, config: { retainedUntilRemoval: true } } },
          installs: { demo: { source: "path", sourcePath, installPath } },
          load: { paths: [aliasPath, unrelatedPath] },
        },
      };
      const planFor = (currentConfig: OpenClawConfig) =>
        planPluginUninstall(
          recordPluginPackageUninstallPlan(
            { config: currentConfig, pluginId: "demo", channelIds: [], extensionsDir },
            { runtimePluginIds: ["demo"], runtimeLoadPaths: [entryPath] },
          ),
        );
      const initial = planFor(config);
      if (!initial.ok) {
        throw new Error(initial.error);
      }
      expect(initial.config.plugins?.load?.paths).toEqual([unrelatedPath]);

      const disabled = prepareConfigForDisabledPluginSet(config, ["demo"], initial.config);
      expect.soft(disabled.plugins?.load?.paths).toEqual([unrelatedPath]);
      expect(disabled.plugins?.entries?.demo).toEqual({
        enabled: false,
        config: { retainedUntilRemoval: true },
      });
      expect(disabled.plugins?.installs).toEqual(config.plugins?.installs);

      await expect(applyPluginUninstallDirectoryRemoval(initial.directoryRemoval)).resolves.toEqual(
        {
          directoryRemoved: true,
          warnings: [],
        },
      );
      await expect(fs.realpath(aliasPath)).rejects.toMatchObject({ code: "ENOENT" });
      const concurrentConfig: OpenClawConfig = {
        ...disabled,
        logging: { level: "debug" },
        plugins: {
          ...disabled.plugins,
          load: { paths: [...(disabled.plugins?.load?.paths ?? []), addedPath] },
        },
      };
      const final = planFor(concurrentConfig);
      if (!final.ok) {
        throw new Error(final.error);
      }
      expect(final.config.plugins?.load?.paths).toEqual([unrelatedPath, addedPath]);
      expect(final.config.logging).toEqual({ level: "debug" });
      expect(final.config.plugins?.entries?.demo).toEqual({ enabled: false });
      expect(final.config.plugins?.installs).toBeUndefined();
      expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
      expect((await fs.stat(unrelatedPath)).isDirectory()).toBe(true);
    },
  );
});
