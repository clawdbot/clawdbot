import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isJavaScriptModulePath } from "../../plugins/native-module-require.js";
import { resolveExistingPluginModulePath } from "./module-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-module-loader-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("channel plugin module loader helpers", () => {
  it("resolves extensionless plugin module specifiers to the first existing extension", () => {
    const rootDir = createTempDir();
    const expectedPath = path.join(rootDir, "src", "checker.mts");
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(expectedPath, "export const ok = true;\n", "utf8");

    expect(resolveExistingPluginModulePath(rootDir, "./src/checker")).toBe(expectedPath);
  });

  it("detects JavaScript module paths case-insensitively", () => {
    expect(isJavaScriptModulePath("/tmp/entry.js")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.MJS")).toBe(true);
    expect(isJavaScriptModulePath("/tmp/entry.ts")).toBe(false);
  });

  it("uses native require for eligible JavaScript modules without creating Jiti", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ ok: false })));
    vi.resetModules();
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const loaderModule = await importFreshModule<typeof import("./module-loader.js")>(
      import.meta.url,
      "./module-loader.js?scope=native-require",
    );
    const rootDir = createTempDir();
    const modulePath = path.join(rootDir, "dist", "extensions", "demo", "index.cjs");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "module.exports = { ok: true };\n", "utf8");

    expect(
      loaderModule.loadChannelPluginModule({
        modulePath,
        rootDir,
      }),
    ).toEqual({ ok: true });
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("loads TypeScript channel plugin modules through Jiti when no native hook exists", async () => {
    const loadWithJiti = vi.fn((target: string) => ({
      loadedBy: "jiti",
      target,
    }));
    const createJiti = vi.fn(() => loadWithJiti);
    vi.resetModules();
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const loaderModule = await importFreshModule<typeof import("./module-loader.js")>(
      import.meta.url,
      "./module-loader.js?scope=source-ts-jiti-fallback",
    );
    const rootDir = createTempDir();
    const modulePath = path.join(rootDir, "extensions", "demo", "index.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export const ok = true;\n", "utf8");

    expect(
      loaderModule.loadChannelPluginModule({
        modulePath,
        rootDir,
      }),
    ).toEqual({
      loadedBy: "jiti",
      target: fs.realpathSync.native(modulePath),
    });
    expect(createJiti).toHaveBeenCalledOnce();
    expect(createJiti).toHaveBeenCalledWith(
      expect.stringContaining("module-loader.ts"),
      expect.objectContaining({ tryNative: false }),
    );
    expect(loadWithJiti).toHaveBeenCalledWith(fs.realpathSync.native(modulePath));
  });
});
