// Tests Canvas A2UI native resource generation.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLinuxCanvasA2uiReferences,
  checkNativeA2uiBuildReferences,
  checkNativeA2uiResources,
  getNativeA2uiResourcePaths,
  syncNativeA2uiResources,
} from "../../scripts/sync-native-a2ui.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeA2uiFixture(dir: string, bundle = "console.log('a2ui');\n") {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html>\n", "utf8");
  await fs.writeFile(path.join(dir, "a2ui.bundle.js"), bundle, "utf8");
}

describe("scripts/sync-native-a2ui.mts", () => {
  it("resolves the plugin-owned source and native build owners", () => {
    const paths = getNativeA2uiResourcePaths("/repo");

    expect(paths).toEqual({
      sourceDir: path.join("/repo", "extensions", "canvas", "src", "host", "a2ui"),
      linuxConsumerFile: path.join("/repo", "apps", "linux", "src-tauri", "src", "canvas.rs"),
      linuxBuildFile: path.join("/repo", "apps", "linux", "src-tauri", "build.rs"),
      androidBuildFile: path.join("/repo", "apps", "android", "app", "build.gradle.kts"),
      iosProjectFile: path.join("/repo", "apps", "ios", "project.yml"),
    });
  });

  it("requires every native build owner to generate isolated resources", async () => {
    const root = tempDirs.make("openclaw-native-a2ui-");
    const paths = {
      linuxBuildFile: path.join(root, "build.rs"),
      androidBuildFile: path.join(root, "build.gradle.kts"),
      iosProjectFile: path.join(root, "project.yml"),
    };
    await Promise.all([
      fs.writeFile(
        paths.linuxBuildFile,
        '.args(["--import", "tsx", "scripts/sync-native-a2ui.mts", "--write", "--output"])',
      ),
      fs.writeFile(
        paths.androidBuildFile,
        [
          'commandLine("node", "--import", "tsx", "scripts/sync-native-a2ui.mts", "--write", "--output")',
          "addGeneratedSourceDirectory(stageCanvasA2ui, StageCanvasA2uiTask::outputDirectory)",
        ].join("\n"),
      ),
      fs.writeFile(
        paths.iosProjectFile,
        [
          "Stage Canvas A2UI resources",
          "node --import tsx scripts/sync-native-a2ui.mts --write --output",
          "pwd -P",
          "$BUILT_PRODUCTS_DIR/OpenClawKit_OpenClawKit.bundle",
          "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH",
          'cp -R "$resource_product/CanvasA2UI"',
        ].join("\n"),
      ),
    ]);

    await expect(checkNativeA2uiBuildReferences(paths)).resolves.toBeUndefined();
    await fs.writeFile(paths.iosProjectFile, "xcodebuild\n");
    await expect(checkNativeA2uiBuildReferences(paths)).rejects.toThrow(
      "Missing owners:\n- iOS app post-build resource stage",
    );
  });

  it("requires Linux Canvas to embed the plugin-owned resources", async () => {
    const root = tempDirs.make("openclaw-native-a2ui-");
    const linuxConsumerFile = path.join(root, "canvas.rs");
    await fs.writeFile(
      linuxConsumerFile,
      [
        'include_bytes!(env!("OPENCLAW_CANVAS_A2UI_INDEX_HTML"));',
        'include_bytes!(env!("OPENCLAW_CANVAS_A2UI_BUNDLE_JS"));',
      ].join("\n"),
    );

    await expect(checkLinuxCanvasA2uiReferences({ linuxConsumerFile })).resolves.toBeUndefined();
    await fs.writeFile(linuxConsumerFile, 'const OTHER: &[u8] = b"stale";\n');
    await expect(checkLinuxCanvasA2uiReferences({ linuxConsumerFile })).rejects.toThrow(
      "Linux Canvas must embed the staged native A2UI resources",
    );
  });

  it("replaces stale native resources with the generated source files", async () => {
    const root = tempDirs.make("openclaw-native-a2ui-");
    const sourceDir = path.join(root, "source");
    const nativeDir = path.join(root, "native");
    await writeA2uiFixture(sourceDir);
    await fs.mkdir(path.join(nativeDir, "assets", "providers"), { recursive: true });
    await fs.writeFile(path.join(nativeDir, "assets", "providers", "granola.png"), "stale");

    await syncNativeA2uiResources({ sourceDir, nativeDir });

    await expect(fs.readdir(nativeDir)).resolves.toEqual(["a2ui.bundle.js", "index.html"]);
    await expect(fs.readFile(path.join(nativeDir, "a2ui.bundle.js"), "utf8")).resolves.toBe(
      "console.log('a2ui');\n",
    );
    await expect(
      fs.stat(path.join(nativeDir, "assets", "providers", "granola.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(root)).resolves.toEqual(["native", "source"]);
  });

  it("fails check mode when native resources contain stale files or stale bytes", async () => {
    const root = tempDirs.make("openclaw-native-a2ui-");
    const sourceDir = path.join(root, "source");
    const nativeDir = path.join(root, "native");
    await writeA2uiFixture(sourceDir);
    await syncNativeA2uiResources({ sourceDir, nativeDir });

    await expect(checkNativeA2uiResources({ sourceDir, nativeDir })).resolves.toBeUndefined();

    await fs.writeFile(path.join(nativeDir, "stale.png"), "old");
    await expect(checkNativeA2uiResources({ sourceDir, nativeDir })).rejects.toThrow(
      "Unexpected:\n- stale.png",
    );

    await fs.rm(path.join(nativeDir, "stale.png"));
    await fs.writeFile(path.join(nativeDir, "a2ui.bundle.js"), "old");
    await expect(checkNativeA2uiResources({ sourceDir, nativeDir })).rejects.toThrow(
      "Mismatched:\n- a2ui.bundle.js",
    );
  });
});
