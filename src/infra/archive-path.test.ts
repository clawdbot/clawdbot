import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-path.js";

function expectArchivePathError(run: () => void, message: string) {
  expect(run).toThrow(message);
}

describe("archive path helpers", () => {
  it.each([
    { value: "C:\\temp\\file.txt", expected: true },
    { value: "D:/temp/file.txt", expected: true },
    { value: "tmp/file.txt", expected: false },
    { value: "/tmp/file.txt", expected: false },
  ])("detects Windows drive paths for %j", ({ value, expected }) => {
    expect(isWindowsDrivePath(value)).toBe(expected);
  });

  it.each([
    { raw: "dir\\file.txt", expected: "dir/file.txt" },
    { raw: "dir/file.txt", expected: "dir/file.txt" },
  ])("normalizes archive separators for %j", ({ raw, expected }) => {
    expect(normalizeArchiveEntryPath(raw)).toBe(expected);
  });

  it.each(["", ".", "./"])("accepts empty-like entry paths: %j", (entryPath) => {
    expect(validateArchiveEntryPath(entryPath)).toBeUndefined();
  });

  it.each([
    {
      name: "uses custom escape labels in traversal errors",
      entryPath: "../escape.txt",
      message: "archive entry escapes targetDir: ../escape.txt",
    },
    {
      name: "rejects Windows drive paths",
      entryPath: "C:\\temp\\file.txt",
      message: "archive entry uses a drive path: C:\\temp\\file.txt",
    },
    {
      name: "rejects absolute paths after normalization",
      entryPath: "/tmp/file.txt",
      message: "archive entry is absolute: /tmp/file.txt",
    },
    {
      name: "rejects double-slash absolute paths after normalization",
      entryPath: "\\\\server\\share.txt",
      message: "archive entry is absolute: \\\\server\\share.txt",
    },
  ])("$name", ({ entryPath, message }) => {
    expectArchivePathError(
      () =>
        validateArchiveEntryPath(entryPath, {
          escapeLabel: "targetDir",
        }),
      message,
    );
  });

  it.each([
    { entryPath: "a/../escape.txt", stripComponents: 1, expected: "../escape.txt" },
    { entryPath: "a//b/file.txt", stripComponents: 1, expected: "b/file.txt" },
    { entryPath: "./", stripComponents: 0, expected: null },
    { entryPath: "a", stripComponents: 3, expected: null },
    { entryPath: "dir\\sub\\file.txt", stripComponents: 1, expected: "sub/file.txt" },
  ])("strips archive paths for %j", ({ entryPath, stripComponents, expected }) => {
    expect(stripArchivePath(entryPath, stripComponents)).toBe(expected);
  });

  it("preserves strip-induced traversal for follow-up validation", () => {
    const stripped = stripArchivePath("a/../escape.txt", 1);
    expect(stripped).toBe("../escape.txt");
    expectArchivePathError(
      () =>
        validateArchiveEntryPath(stripped ?? "", {
          escapeLabel: "targetDir",
        }),
      "archive entry escapes targetDir: ../escape.txt",
    );
  });

  const rootDir = path.join(path.sep, "tmp", "archive-root");

  it.each([
    {
      name: "keeps resolved output paths inside the root",
      relPath: "sub/file.txt",
      originalPath: "sub/file.txt",
      expected: path.resolve(rootDir, "sub/file.txt"),
    },
    {
      name: "rejects output paths that escape the root",
      relPath: "../escape.txt",
      originalPath: "../escape.txt",
      escapeLabel: "targetDir",
      message: "archive entry escapes targetDir: ../escape.txt",
    },
  ])("$name", ({ relPath, originalPath, escapeLabel, expected, message }) => {
    if (message) {
      expectArchivePathError(
        () =>
          resolveArchiveOutputPath({
            rootDir,
            relPath,
            originalPath,
            escapeLabel,
          }),
        message,
      );
      return;
    }

    expect(
      resolveArchiveOutputPath({
        rootDir,
        relPath,
        originalPath,
      }),
    ).toBe(expected);
  });
});
