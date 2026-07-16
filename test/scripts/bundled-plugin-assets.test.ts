// Bundled Plugin Assets tests cover bundled plugin assets script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBundledPluginAssetArgs,
  readBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mjs";

async function withPluginAssetFixture(run: (rootDir: string) => Promise<void>) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-assets-"));
  try {
    fs.mkdirSync(path.join(rootDir, "extensions", "canvas"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "extensions", "canvas", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/canvas-plugin",
          openclaw: {
            assetScripts: {
              build: "node scripts/bundle-a2ui.mjs",
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
  } finally {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
}

describe("bundled plugin assets", () => {
  it("resolves the Discord SDK entry from the package that declares it", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts/build-discord-activity-sdk.mjs"),
      "utf8",
    );

    expect(script).toContain('const discordDir = path.join(repoRoot, "extensions/discord")');
    expect(script).toContain("absWorkingDir: discordDir");
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
