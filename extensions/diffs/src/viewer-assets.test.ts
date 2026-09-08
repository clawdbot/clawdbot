import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const VIEWER_LOADER_PATH = "/plugins/diffs/assets/viewer.js";
const LANGUAGE_PACK_VIEWER_LOADER_PATH = "/plugins/diffs-language-pack/assets/viewer.js";
const BUILT_RUNTIME_PATH = fileURLToPath(new URL("./assets/viewer-runtime.js", import.meta.url));
const SOURCE_RUNTIME_PATH = fileURLToPath(new URL("../assets/viewer-runtime.js", import.meta.url));
const ROOT_BUNDLE_RUNTIME_PATH = fileURLToPath(
  new URL("./extensions/diffs/assets/viewer-runtime.js", import.meta.url),
);
const LANGUAGE_PACK_SOURCE_RUNTIME_PATH = fileURLToPath(
  new URL("../../diffs-language-pack/assets/viewer-runtime.js", import.meta.url),
);
const LANGUAGE_PACK_FALLBACK_RUNTIME_PATH = fileURLToPath(
  new URL("../diffs-language-pack/assets/viewer-runtime.js", import.meta.url),
);
const ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH = fileURLToPath(
  new URL("./extensions/diffs-language-pack/assets/viewer-runtime.js", import.meta.url),
);

function missingFile(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
}

async function loadViewerWithRuntimeAt(runtimePath: string) {
  const stat = vi.spyOn(fs, "stat").mockImplementation(async (path) => {
    const candidate = String(path);
    if (candidate === runtimePath) {
      return { mtimeMs: 1 } as never;
    }
    throw missingFile(candidate);
  });
  vi.spyOn(fs, "readFile").mockResolvedValue(
    Buffer.from("window.openclawDiffsReady = true;\n") as never,
  );
  const { getServedViewerAsset } = await import("./viewer-assets.js");
  const loader = await getServedViewerAsset(VIEWER_LOADER_PATH);
  expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
  expect(String(loader?.body)).toContain("./viewer-runtime.js?v=");
  return stat;
}

async function loadLanguagePackViewerWithRuntimeAt(runtimePath: string) {
  const stat = vi.spyOn(fs, "stat").mockImplementation(async (path) => {
    const candidate = String(path);
    if (candidate === runtimePath) {
      return { mtimeMs: 1 } as never;
    }
    throw missingFile(candidate);
  });
  vi.spyOn(fs, "readFile").mockResolvedValue(
    Buffer.from("window.openclawDiffsReady = true;\n") as never,
  );
  const { getServedLanguagePackViewerAsset } = await import("./viewer-assets.js");
  const loader = await getServedLanguagePackViewerAsset(LANGUAGE_PACK_VIEWER_LOADER_PATH);
  expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
  expect(String(loader?.body)).toContain("./viewer-runtime.js?v=");
  return stat;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("viewer runtime resolution", () => {
  it("prefers the built plugin asset layout when present", async () => {
    const stat = await loadViewerWithRuntimeAt(BUILT_RUNTIME_PATH);

    expect(stat).toHaveBeenNthCalledWith(1, BUILT_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(2, BUILT_RUNTIME_PATH);
  });

  it("falls back to the source asset layout when the built artifact is absent", async () => {
    const stat = await loadViewerWithRuntimeAt(SOURCE_RUNTIME_PATH);

    expect(stat).toHaveBeenNthCalledWith(1, BUILT_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(2, SOURCE_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(3, SOURCE_RUNTIME_PATH);
  });

  it("serves the runtime from the unified root bundle layout", async () => {
    const stat = await loadViewerWithRuntimeAt(ROOT_BUNDLE_RUNTIME_PATH);

    expect(stat).toHaveBeenNthCalledWith(1, BUILT_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(2, SOURCE_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(3, ROOT_BUNDLE_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(4, ROOT_BUNDLE_RUNTIME_PATH);
  });

  it("serves the language pack from the unified root bundle layout", async () => {
    const stat = await loadLanguagePackViewerWithRuntimeAt(ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH);

    expect(stat).toHaveBeenNthCalledWith(1, LANGUAGE_PACK_SOURCE_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(2, LANGUAGE_PACK_FALLBACK_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(3, ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH);
    expect(stat).toHaveBeenNthCalledWith(4, ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH);
  });
});
