import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toWatchRoot } from "./refresh-watch-path.js";

const parseWindows = path.win32.parse;
const parsePosix = path.posix.parse;

afterEach(() => vi.restoreAllMocks());

describe("watch root normalization", () => {
  it.each([
    ["C:\\", "C:/"],
    ["C:////", "C:/"],
    ["\\\\server\\share\\", "//server/share/"],
    ["C:\\project\\skills\\", "C:/project/skills"],
  ])("preserves the absolute Windows filesystem boundary for %s", (input, expected) => {
    if (process.platform !== "win32") {
      vi.spyOn(path, "parse").mockImplementation(parseWindows);
    }
    const root = toWatchRoot(input);
    expect(root).toBe(expected);
    expect(path.win32.isAbsolute(root)).toBe(true);
    expect(parseWindows(root).root).toBe(parseWindows(input).root.replaceAll("\\", "/"));
  });

  it("preserves POSIX roots and trims ordinary directory separators", () => {
    if (process.platform === "win32") {
      vi.spyOn(path, "parse").mockImplementation(parsePosix);
    }
    expect(toWatchRoot("/")).toBe("/");
    expect(toWatchRoot("/tmp/skills///")).toBe("/tmp/skills");
  });
});
