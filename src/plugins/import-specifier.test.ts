import { afterEach, describe, expect, it, vi } from "vitest";
import { toSafeImportPath } from "./import-specifier.js";

describe("toSafeImportPath", () => {
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

  it("preserves import specifiers that Node can already resolve", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(toSafeImportPath("file:///C:/Users/alice/plugin/index.mjs")).toBe(
      "file:///C:/Users/alice/plugin/index.mjs",
    );
    expect(toSafeImportPath("./relative/index.mjs")).toBe("./relative/index.mjs");
    expect(toSafeImportPath("@openclaw/plugin")).toBe("@openclaw/plugin");
  });

  it("does not rewrite non-Windows paths", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    expect(toSafeImportPath("C:\\Users\\alice\\plugin\\index.mjs")).toBe(
      "C:\\Users\\alice\\plugin\\index.mjs",
    );
  });
});
