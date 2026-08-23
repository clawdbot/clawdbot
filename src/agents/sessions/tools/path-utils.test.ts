import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveToCwd } from "./path-utils.js";

describe("resolveToCwd", () => {
  const cwd = path.resolve("workspace");

  it("resolves ordinary relative paths against cwd", () => {
    expect(resolveToCwd("notes/today.md", cwd)).toBe(path.resolve(cwd, "notes/today.md"));
  });

  it("keeps Unicode spaces in the destination path", () => {
    const nnbsp = "Screenshot 9.30\u202FAM.png";
    const ascii = "Screenshot 9.30 AM.png";
    expect(resolveToCwd(nnbsp, cwd)).toBe(path.resolve(cwd, nnbsp));
    expect(resolveToCwd(nnbsp, cwd)).not.toBe(path.resolve(cwd, ascii));
  });

  it("resolves valid file URLs to their filesystem path", () => {
    const target = path.resolve(cwd, "notes.txt");
    expect(resolveToCwd(pathToFileURL(target).href, cwd)).toBe(target);
  });

  it("keeps malformed file URLs on the ordinary relative-path path", () => {
    const malformed = "file://%";
    expect(resolveToCwd(malformed, cwd)).toBe(path.resolve(cwd, malformed));
  });

  it.runIf(process.platform === "win32")(
    "expands a Windows-style home prefix against the OS home",
    () => {
      const homeDir = process.env.HOME ?? os.homedir();
      expect(resolveToCwd("~\\notes.txt", cwd)).toBe(path.resolve(homeDir, "notes.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a backslash-prefixed tilde literal on POSIX",
    () => {
      expect(resolveToCwd("~\\notes.txt", cwd)).toBe(path.resolve(cwd, "~\\notes.txt"));
    },
  );
});
