// E2E text file utility tests cover bounded diagnostic file reads.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTextFileBounded,
  readTextFileTail,
  tailText,
} from "../../scripts/e2e/lib/text-file-utils.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempRoots: string[] = [];

function makeTempRoot() {
  return makeTempDir(tempRoots, "openclaw-e2e-text-file-utils-");
}

afterEach(() => {
  cleanupTempDirs(tempRoots);
});

describe("e2e text file utilities", () => {
  it("keeps short diagnostic text intact and trims long text by byte count", () => {
    expect(tailText("short", 8)).toBe("short");
    expect(tailText("prefix-tail", 4)).toBe("tail");
    expect(tailText("prefix \u{1f600}tail", 7)).toBe("tail");
    expect(tailText("prefix \u{1f600}tail", 8)).toBe("\u{1f600}tail");
  });

  it("reads only the requested file tail and treats missing or non-file paths as empty", () => {
    const root = makeTempRoot();
    const file = path.join(root, "output.log");
    const directory = path.join(root, "nested");
    mkdirSync(directory);
    writeFileSync(file, "line-one\nline-two\nline-three", "utf8");

    expect(readTextFileTail(file, 10)).toBe("line-three");
    writeFileSync(file, "prefix \u{1f600}tail", "utf8");
    expect(readTextFileTail(file, 7)).toBe("tail");
    expect(readTextFileTail(file, 8)).toBe("\u{1f600}tail");
    writeFileSync(file, Buffer.concat([Buffer.from("prefix tail"), Buffer.from([0xf0])]));
    expect(readTextFileTail(file, 5)).toBe("tail\ufffd");
    expect(readTextFileTail(path.join(root, "missing.log"), 10)).toBe("");
    expect(readTextFileTail(directory, 10)).toBe("");
  });

  it("returns bounded file text and reports oversize diagnostics with a tail", () => {
    const root = makeTempRoot();
    const file = path.join(root, "artifact.json");
    writeFileSync(file, `old prefix\n${"x".repeat(64)}\nfinal tail`, "utf8");

    expect(readTextFileBounded(file, "artifact", 256)).toContain("final tail");

    expect(() => readTextFileBounded(file, "artifact", 32, { tailBytes: 10 })).toThrowError(
      /artifact exceeded 32 bytes: .* Tail: final tail/u,
    );
  });
});
