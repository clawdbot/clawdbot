import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveReadPath } from "./path-utils.js";

describe("resolveReadPath", () => {
  const cwd = path.resolve("workspace");

  it("resolves ordinary relative paths against cwd", () => {
    expect(resolveReadPath("notes/today.md", cwd)).toBe(path.resolve(cwd, "notes/today.md"));
  });

  it("resolves valid file URLs to their filesystem path", () => {
    const target = path.resolve(cwd, "notes.txt");
    expect(resolveReadPath(pathToFileURL(target).href, cwd)).toBe(target);
  });

  it("keeps malformed file URLs on the ordinary relative-path path", () => {
    const malformed = "file://%";
    expect(resolveReadPath(malformed, cwd)).toBe(path.resolve(cwd, malformed));
  });

  it.runIf(process.platform === "win32")(
    "expands a Windows-style home prefix against the OS home",
    () => {
      const homeDir = process.env.HOME ?? os.homedir();
      expect(resolveReadPath("~\\notes.txt", cwd)).toBe(path.resolve(homeDir, "notes.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a backslash-prefixed tilde literal on POSIX",
    () => {
      expect(resolveReadPath("~\\notes.txt", cwd)).toBe(path.resolve(cwd, "~\\notes.txt"));
    },
  );
});
