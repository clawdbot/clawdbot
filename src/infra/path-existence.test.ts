import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { pathMayExistSync } from "./path-existence.js";

it("distinguishes definite absence from paths that may still exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-existence-"));
  try {
    const present = path.join(root, "present");
    fs.writeFileSync(present, "");
    expect(pathMayExistSync(present)).toBe(true);
    expect(pathMayExistSync(path.join(root, "missing"))).toBe(false);

    const dangling = path.join(root, "dangling");
    fs.symlinkSync("missing-target", dangling);
    expect(pathMayExistSync(dangling)).toBe(true);
    const blockedByFile = path.join(present, "child");
    expect(() => fs.lstatSync(blockedByFile)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
    expect(pathMayExistSync(blockedByFile)).toBe(true);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
