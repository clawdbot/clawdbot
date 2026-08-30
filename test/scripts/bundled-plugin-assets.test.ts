// Bundled Plugin Assets tests cover bundled plugin assets script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mts";
import {
  listStaleGeneratedPluginAssets,
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
  runBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mts";
import { listGeneratedExtensionAssetSources } from "../../scripts/lib/static-extension-assets.mts";
import {
  createRunNodePathClassifier,
  isBuildRelevantRunNodePath,
  isRestartRelevantRunNodePath,
} from "../../scripts/run-node-watch-paths.mts";
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
            build: "node --import tsx scripts/bundle-a2ui.mts",
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
        command: "node --import tsx ../../scripts/build-discord-activity-sdk.mts",
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

    expect(generatedAssetSources).toContain("extensions/canvas/src/host/a2ui/.bundle.hash");
    expect(generatedAssetSources).toContain("extensions/canvas/src/host/a2ui/a2ui.bundle.js");
    expect(generatedAssetSources).toContain("extensions/discord/assets/embedded-app-sdk.mjs");
    for (const source of generatedAssetSources) {
      expect(isBuildRelevantRunNodePath(source), source).toBe(false);
      expect(isRestartRelevantRunNodePath(source), source).toBe(false);
    }
    expect(isRestartRelevantRunNodePath("extensions/discord/src/activities/http.ts")).toBe(true);
  });

  it.each(["packages/ai/src/host.ts", "packages/llm-core/src/types.ts"])(
    "rebuilds the root runtime for %s",
    (source) => {
      expect(isBuildRelevantRunNodePath(source)).toBe(true);
      expect(isRestartRelevantRunNodePath(source)).toBe(true);
    },
  );

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
          command: "node --import tsx scripts/bundle-a2ui.mts",
          packageName: "@openclaw/canvas-plugin",
          phase: "build",
          pluginDir: path.join(rootDir, "extensions", "canvas"),
          pluginId: "canvas",
        },
      ]);
    });
  });

  it("bounds stalled asset hooks and reports the affected plugin safely", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const pluginDir = path.join(rootDir, "extensions", "canvas");
      const packagePath = path.join(pluginDir, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        openclaw: { assetScripts: { build: string } };
      };
      packageJson.openclaw.assetScripts.build = "node scripts/launch-stall.mjs";
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
      fs.mkdirSync(path.join(pluginDir, "scripts"));
      const pidFile = path.join(pluginDir, "stall.pid");
      const readyFile = path.join(pluginDir, "stall.ready");
      fs.writeFileSync(
        path.join(pluginDir, "scripts", "stall.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          'process.on("SIGTERM", () => {});',
          `writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
          "setInterval(() => {}, 100);",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(pluginDir, "scripts", "launch-stall.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'process.on("SIGTERM", () => {});',
          'const child = spawn(process.execPath, ["scripts/stall.mjs"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "setInterval(() => {}, 100);",
          "",
        ].join("\n"),
      );

      let thrown: unknown;
      let childPid = 0;
      try {
        await runBundledPluginAssetHooks({ phase: "build", rootDir, timeoutMs: 500 });
      } catch (error) {
        thrown = error;
      }
      try {
        childPid = Number(fs.readFileSync(pidFile, "utf8"));
        // Timeout rejection must join cleanup, not leave the caller to poll for it.
        expect(isProcessAlive(childPid)).toBe(false);
        expect(fs.readFileSync(readyFile, "utf8")).toBe(String(childPid));
        expect(thrown).toMatchObject({
          code: "ETIMEDOUT",
          message: "Bundled plugin asset build hook timed out after 500ms: canvas",
        });
        expect((thrown as Error).message).not.toContain("launch-stall.mjs");
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    });
  });

  it("skips cleanly when a requested plugin is absent", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      await expect(
        readBundledPluginAssetHooks({ phase: "copy", plugins: ["missing"], rootDir }),
      ).resolves.toStrictEqual([]);
    });
  });

  it("rejects a symlinked dist root before running copy hooks", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const targetDir = path.join(rootDir, "live-gateway-dist");
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, "sentinel.js"), "keep\n");
      fs.symlinkSync(targetDir, path.join(rootDir, "dist"), "dir");

      await expect(runBundledPluginAssetHooks({ phase: "copy", rootDir })).rejects.toThrow(
        /symbolic link/u,
      );
      expect(fs.readFileSync(path.join(targetDir, "sentinel.js"), "utf8")).toBe("keep\n");
      expect(fs.readlinkSync(path.join(rootDir, "dist"))).toBe(targetDir);
    });
  });

  it("parses phase and plugin filters", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--plugin=canvas"])).toEqual({
      check: false,
      phase: "build",
      plugins: ["canvas"],
    });
  });

  it("parses whole-repo check runs and rejects filtered or copy-phase checks", () => {
    expect(parseBundledPluginAssetArgs(["--phase", "build", "--check"])).toEqual({
      check: true,
      phase: "build",
      plugins: [],
    });
    expect(() => parseBundledPluginAssetArgs(["--phase", "copy", "--check"])).toThrow(
      "--check requires --phase build",
    );
    expect(() =>
      parseBundledPluginAssetArgs(["--phase", "build", "--check", "--plugin=canvas"]),
    ).toThrow("--check cannot be combined with --plugin filters");
  });

  it("reports declared generated outputs that differ from the committed bytes", async () => {
    await withPluginAssetFixture(async (rootDir) => {
      const generatedPath = path.join(
        rootDir,
        "extensions",
        "canvas",
        "assets",
        "generated-runtime.js",
      );
      fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
      fs.writeFileSync(generatedPath, "export const generated = 1;\n");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
      git("init", "--quiet");
      git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "init");

      expect(listStaleGeneratedPluginAssets({ rootDir })).toEqual([]);

      fs.writeFileSync(generatedPath, "export const generated = 2;\n");
      expect(listStaleGeneratedPluginAssets({ rootDir })).toEqual([
        "extensions/canvas/assets/generated-runtime.js",
      ]);
    });
  });
});

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}
