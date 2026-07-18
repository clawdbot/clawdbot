// Bundled Plugin Assets tests cover bundled plugin assets script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mjs";
import {
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mjs";
import { listGeneratedExtensionAssetSources } from "../../scripts/lib/static-extension-assets.mjs";
import {
  createRunNodePathClassifier,
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
} from "../../scripts/run-node-watch-paths.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withPluginAssetFixture(run: (rootDir: string) => Promise<void>) {
  const rootDir = tempDirs.make("openclaw-plugin-assets-");
  fs.mkdirSync(path.join(rootDir, "extensions", "canvas"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "extensions", "canvas", "package.json"),
    JSON.stringify(
      {
        name: "@openclaw/canvas-plugin",
        openclaw: {
          assetScripts: {
            build: "node scripts/bundle-a2ui.mjs",
            buildOutputs: ["assets/generated-runtime.js"],
            copy: "node scripts/copy-a2ui.mjs",
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(rootDir, "extensions", "canvas", "openclaw.plugin.json"),
    JSON.stringify({ id: "canvas" }, null, 2),
  );
  await run(rootDir);
}

describe("bundled plugin assets", () => {
  it("creates a missing Discord SDK bundle without rewriting it when unchanged", async () => {
    const rootDir = tempDirs.make("openclaw-discord-sdk-");
    const outputPath = path.join(rootDir, "embedded-app-sdk.mjs");
    const build = vi.fn(async () => ({
      outputFiles: [{ text: "export const sdk = true;\n" }],
    }));

    await expect(buildDiscordActivitySdk({ build, outputPath })).resolves.toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("export const sdk = true;\n");

    const initialTime = new Date("2026-07-16T12:00:00.000Z");
    fs.utimesSync(outputPath, initialTime, initialTime);

    await expect(buildDiscordActivitySdk({ build, outputPath })).resolves.toBe(false);
    expect(fs.statSync(outputPath).mtimeMs).toBe(initialTime.getTime());
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        absWorkingDir: path.join(process.cwd(), "extensions/discord"),
        outfile: outputPath,
        write: false,
      }),
    );
  });

  it("discovers the Discord Embedded App SDK build hook", async () => {
    const hooks = await readBundledPluginAssetHooks({
      phase: "build",
      plugins: ["discord"],
      rootDir: process.cwd(),
    });

    expect(hooks).toMatchObject([
      {
        command: "node ../../scripts/build-discord-activity-sdk.mjs",
        packageName: "@openclaw/discord",
        phase: "build",
        pluginId: "discord",
      },
    ]);
  });

  it("keeps build-generated static assets out of the source watcher", async () => {
    const rootDir = process.cwd();
    const hooks = await readBundledPluginAssetHooks({ phase: "build", rootDir });
    const generatedAssetSources = listGeneratedExtensionAssetSources({ rootDir });

    for (const hook of hooks) {
      const pluginPath = path.relative(rootDir, hook.pluginDir).replaceAll(path.sep, "/");
      expect(
        generatedAssetSources.some((source) => source.startsWith(`${pluginPath}/`)),
        `${hook.pluginId} build hook must declare at least one generated output`,
      ).toBe(true);
    }

    expect(generatedAssetSources).toContain(
      "extensions/browser/chrome-extension/modules/copilot-runtime.js",
    );
    expect(generatedAssetSources).toContain("extensions/canvas/src/host/a2ui/.bundle.hash");
    expect(generatedAssetSources).toContain("extensions/canvas/src/host/a2ui/a2ui.bundle.js");
    expect(generatedAssetSources).toContain("extensions/discord/assets/embedded-app-sdk.mjs");
    for (const source of generatedAssetSources) {
      expect(isBuildRelevantRunNodePath(source), source).toBe(false);
      expect(isRestartRelevantRunNodePath(source), source).toBe(false);
    }
    expect(
      isRestartRelevantRunNodePath("extensions/browser/scripts/copilot-runtime-entry.ts"),
    ).toBe(true);
    expect(isRestartRelevantRunNodePath("extensions/discord/src/activities/http.ts")).toBe(true);
  });

  it("refreshes generated output metadata without recreating the watcher", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const packagePath = path.join(rootDir, "extensions", "canvas", "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        openclaw: { assetScripts: { buildOutputs?: string[] } };
      };
      delete packageJson.openclaw.assetScripts.buildOutputs;
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

      const classifier = createRunNodePathClassifier({ rootDir });
      classifier.refreshGeneratedPluginAssetPaths();
      const generatedPath = "extensions/canvas/assets/generated-runtime.js";
      expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(true);

      packageJson.openclaw.assetScripts.buildOutputs = ["assets/generated-runtime.js"];
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
      classifier.refreshGeneratedPluginAssetPaths();

      expect(classifier.isBuildRelevantRunNodePath(generatedPath)).toBe(false);
      expect(classifier.isRestartRelevantRunNodePath(generatedPath)).toBe(false);
    });
  });

  it("discovers plugin-owned asset scripts by manifest id", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const hooks = await readBundledPluginAssetHooks({
        phase: "build",
        plugins: ["canvas"],
        rootDir,
      });

      expect(hooks).toEqual([
        {
          aliases: ["@openclaw/canvas-plugin", "canvas", "canvas-plugin"],
          command: "node scripts/bundle-a2ui.mjs",
          packageName: "@openclaw/canvas-plugin",
          phase: "build",
          pluginDir: path.join(rootDir, "extensions", "canvas"),
          pluginId: "canvas",
        },
      ]);
    });
  });

  it("skips cleanly when a requested plugin is absent", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      await expect(
        readBundledPluginAssetHooks({ phase: "copy", plugins: ["missing"], rootDir }),
      ).resolves.toStrictEqual([]);
    });
  });

  it("parses phase and plugin filters", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--plugin=canvas"])).toEqual({
      phase: "build",
      plugins: ["canvas"],
    });
  });
});
