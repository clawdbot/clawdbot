import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importRuntimeModule,
  resolveRuntimeImportSpecifier,
  toSafeRuntimeImportPath,
} from "./runtime-import.js";

describe("runtime-import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts Windows absolute import specifiers to file URLs", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(toSafeRuntimeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
      "file:///C:/Users/alice/plugin/index.mjs",
    );
    expect(toSafeRuntimeImportPath("C:\\Users\\alice\\plugin folder\\x#y.mjs")).toBe(
      "file:///C:/Users/alice/plugin%20folder/x%23y.mjs",
    );
    expect(toSafeRuntimeImportPath("\\\\server\\share\\plugin\\index.mjs")).toBe(
      "file://server/share/plugin/index.mjs",
    );
  });

  it("resolves runtime imports from Windows absolute base paths", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      resolveRuntimeImportSpecifier("C:\\Users\\alice\\openclaw\\dist\\subagent-registry.js", [
        "./subagent-registry.runtime.js",
      ]),
    ).toBe("file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js");
  });

  it("resolves runtime imports from file URL base paths", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      resolveRuntimeImportSpecifier("file:///C:/Users/alice/openclaw/dist/subagent-registry.js", [
        "./subagent-registry.runtime.js",
      ]),
    ).toBe("file:///C:/Users/alice/openclaw/dist/subagent-registry.runtime.js");
  });

  it("resolves absolute Windows runtime import parts directly", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(
      resolveRuntimeImportSpecifier("file:///C:/Users/alice/openclaw/dist/subagent-registry.js", [
        "D:\\OpenClaw\\dist\\subagent-registry.runtime.js",
      ]),
    ).toBe("file:///D:/OpenClaw/dist/subagent-registry.runtime.js");
  });

  it("keeps non-Windows import paths unchanged", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    expect(toSafeRuntimeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
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
