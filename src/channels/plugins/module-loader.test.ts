// Module loader tests cover channel plugin module resolution and import failure handling.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isJavaScriptModulePath } from "../../plugins/native-module-require.js";
import { loadChannelPluginModule, resolveExistingPluginModulePath } from "./module-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testRequire = createRequire(import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("../../plugins/plugin-module-loader-cache.js");
});

function normalizeModuleLoaderTarget(target: string): string {
  if (target.startsWith("file:")) {
    return fileURLToPath(target);
  }
  return target;
}

describe("channel plugin module loader helpers", () => {
  it("resolves extensionless plugin module specifiers to the first existing extension", () => {
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
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

  it("reports a missing plugin module as not found instead of a boundary escape", () => {
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const modulePath = path.join(rootDir, "dist", "extensions", "demo", "auth-presence.js");

    let thrown: unknown;
    try {
      loadChannelPluginModule({ modulePath, rootDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(`plugin module path not found: ${modulePath}`);
    expect((thrown as Error).message).not.toContain("escapes");
    expect(((thrown as Error).cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("still reports a module outside the plugin root as a boundary escape", () => {
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const outsideDir = tempDirs.make("openclaw-channel-module-loader-");
    const modulePath = path.join(outsideDir, "evil.cjs");
    fs.writeFileSync(modulePath, "module.exports = { ok: true };\n", "utf8");

    expect(() => loadChannelPluginModule({ modulePath, rootDir })).toThrow(
      `plugin module path escapes plugin root or fails alias checks: ${modulePath}`,
    );
  });

  it("uses native require for eligible JavaScript modules without creating Jiti", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ ok: false })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const loaderModule = await importFreshModule<typeof import("./module-loader.js")>(
      import.meta.url,
      "./module-loader.js?scope=native-require",
    );
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
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

  it("loads TypeScript channel plugin modules through Jiti when native loading is unavailable", async () => {
    const loadWithJiti = vi.fn((target: string) => ({
      loadedBy: "jiti",
      target: normalizeModuleLoaderTarget(target),
    }));
    const getCachedPluginModuleLoader = vi.fn(() => loadWithJiti);
    vi.doMock("../../plugins/plugin-module-loader-cache.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../plugins/plugin-module-loader-cache.js")>()),
      getCachedPluginModuleLoader,
    }));
    const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"] as const;
    const sourceHooks = new Map<string, NodeJS.RequireExtensions[string] | undefined>();
    for (const extension of sourceExtensions) {
      sourceHooks.set(extension, testRequire.extensions[extension]);
      delete testRequire.extensions[extension];
    }
    const loaderModule = await importFreshModule<typeof import("./module-loader.js")>(
      import.meta.url,
      "./module-loader.js?scope=source-ts-jiti-fallback",
    );
    const rootDir = tempDirs.make("openclaw-channel-module-loader-");
    const modulePath = path.join(rootDir, "extensions", "demo", "index.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'throw new Error("native source load failed");\n', "utf8");

    try {
      expect(
        loaderModule.loadChannelPluginModule({
          modulePath,
          rootDir,
        }),
      ).toEqual({
        loadedBy: "jiti",
        target: fs.realpathSync.native(modulePath),
      });
      expect(getCachedPluginModuleLoader).toHaveBeenCalledOnce();
      expect(getCachedPluginModuleLoader).toHaveBeenCalledWith(
        expect.objectContaining({
          modulePath: fs.realpathSync.native(modulePath),
          tryNative: false,
          cacheScopeKey: "channel-plugin-module-loader",
        }),
      );
      expect(normalizeModuleLoaderTarget(loadWithJiti.mock.calls[0]?.[0] ?? "")).toBe(
        fs.realpathSync.native(modulePath),
      );
    } finally {
      for (const [extension, hook] of sourceHooks) {
        if (hook) {
          testRequire.extensions[extension] = hook;
        } else {
          delete testRequire.extensions[extension];
        }
      }
    }
  });
});
