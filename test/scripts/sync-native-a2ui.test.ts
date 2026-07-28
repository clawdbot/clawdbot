// Tests the Canvas A2UI native resource sync guard.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLinuxCanvasA2uiReferences,
  checkNativeA2uiResources,
  getNativeA2uiResourcePaths,
  syncNativeA2uiResources,
} from "../../scripts/sync-native-a2ui.mjs";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-native-a2ui-"));
  tempDirs.push(dir);
  return dir;
}

async function writeA2uiFixture(dir: string, bundle = "console.log('a2ui');\n") {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html>\n", "utf8");
  await fs.writeFile(path.join(dir, "a2ui.bundle.js"), bundle, "utf8");
}

describe("scripts/sync-native-a2ui.mjs", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves the plugin-owned source and native resource directories", () => {
    const paths = getNativeA2uiResourcePaths("/repo");

    expect(paths).toEqual({
      sourceDir: path.join("/repo", "extensions", "canvas", "src", "host", "a2ui"),
      nativeDir: path.join(
        "/repo",
        "apps",
        "shared",
        "OpenClawKit",
        "Sources",
        "OpenClawKit",
        "Resources",
        "CanvasA2UI",
      ),
      linuxConsumerFile: path.join("/repo", "apps", "linux", "src-tauri", "src", "canvas.rs"),
    });
  });

  it("requires Linux Canvas to embed the plugin-owned resources", async () => {
    const root = await makeTempDir();
    const linuxConsumerFile = path.join(root, "canvas.rs");
    await fs.writeFile(
      linuxConsumerFile,
      [
        'include_bytes!("../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/index.html");',
        'include_bytes!("../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/a2ui.bundle.js");',
      ].join("\n"),
    );

    await expect(checkLinuxCanvasA2uiReferences({ linuxConsumerFile })).resolves.toBeUndefined();
    await fs.writeFile(linuxConsumerFile, 'const OTHER: &[u8] = b"stale";\n');
    await expect(checkLinuxCanvasA2uiReferences({ linuxConsumerFile })).rejects.toThrow(
      "Linux Canvas must embed the synced native A2UI resources",
    );
  });

  it("replaces stale native resources with the generated source files", async () => {
    const root = await makeTempDir();
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
  });

  it("fails check mode when native resources contain stale files or stale bytes", async () => {
    const root = await makeTempDir();
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
