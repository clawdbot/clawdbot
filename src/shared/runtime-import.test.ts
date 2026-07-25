// Runtime import tests cover lazy runtime import caching and failure handling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSafeImportPath } from "./import-specifier.js";
import { importRuntimeModule } from "./runtime-import.js";

async function captureRuntimeImportSpecifier(baseUrl: string, parts: readonly string[]) {
  const importModule = vi.fn(async (specifier: string) => ({ specifier }));
  await importRuntimeModule(baseUrl, parts, importModule);
  return importModule.mock.calls[0]?.[0];
}

describe("runtime-import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts Windows absolute import specifiers to file URLs", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
      "file:///C:/Users/alice/plugin/index.mjs",
    );
    expect(toSafeImportPath("C:\\Users\\alice\\plugin folder\\x#y.mjs")).toBe(
      "file:///C:/Users/alice/plugin%20folder/x%23y.mjs",
    );
    expect(toSafeImportPath("\\\\server\\share\\plugin\\index.mjs")).toBe(
      "file://server/share/plugin/index.mjs",
    );
  });

  it("resolves runtime imports from Windows absolute base paths", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      await captureRuntimeImportSpecifier(
        "C:\\Users\\alice\\openclaw\\dist\\subagent-registry.js",
        ["./subagent-registry.runtime.js"],
      ),
    ).toBe("file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js");
  });

  it("resolves runtime imports from file URL base paths", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      await captureRuntimeImportSpecifier(
        "file:///C:/Users/alice/openclaw/dist/subagent-registry.js",
        ["./subagent-registry.runtime.js"],
      ),
    ).toBe("file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js");
  });

  it("resolves absolute Windows runtime import parts directly", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      await captureRuntimeImportSpecifier(
        "file:///C:/Users/alice/openclaw/dist/subagent-registry.js",
        ["D:\\OpenClaw\\dist\\subagent-registry.runtime.js"],
      ),
    ).toBe("file:///D:/OpenClaw/dist/subagent-registry.runtime.js");
  });

  it("keeps non-Windows import paths unchanged", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    expect(toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
      "C:\\Users\\alice\\plugin\\index.mjs",
    );
  });

  it("imports with the normalized runtime specifier", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const importModule = vi.fn(async (specifier: string) => ({ specifier }));

    const result = await importRuntimeModule(
      "C:\\Users\\alice\\openclaw\\dist\\subagent-registry.js",
      ["./subagent-registry.runtime.js"],
      importModule,
    );

    expect(importModule).toHaveBeenCalledWith(
      "file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js",
    );
    expect(result).toEqual({
      specifier: "file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js",
    });
  });
});
