import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  createTarEntryPreflightChecker,
  resolveArchiveKind,
  resolvePackedRootDir,
} from "./archive.js";
import { pathExists, withTimeout } from "./fs-safe.js";
import { JsonFileReadError, readJsonFileStrict } from "./json-files.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-archive-helper-test-");

function expectTarPreflightError(
  checker: ReturnType<typeof createTarEntryPreflightChecker>,
  entry: Parameters<ReturnType<typeof createTarEntryPreflightChecker>>[0],
  expected: string | RegExp,
): void {
  expect(() => checker(entry)).toThrow(expected);
}

afterEach(async () => {
  vi.useRealTimers();
  await tempDirs.cleanup();
});

describe("archive helpers", () => {
  it.each([
    { input: "/tmp/file.zip", expected: "zip" },
    { input: "/tmp/file.TAR.GZ", expected: "tar" },
    { input: "/tmp/file.tgz", expected: "tar" },
    { input: "/tmp/file.tar", expected: "tar" },
    { input: "/tmp/file.txt", expected: null },
  ])("detects archive kind for $input", ({ input, expected }) => {
    expect(resolveArchiveKind(input)).toBe(expected);
  });

  it.each([
    {
      name: "uses the package directory when present",
      setup: async (root: string) => {
        await fs.mkdir(path.join(root, "package"), { recursive: true });
      },
      expected: (root: string) => path.join(root, "package"),
    },
    {
      name: "uses the single extracted root directory as a fallback",
      setup: async (root: string) => {
        await fs.mkdir(path.join(root, "bundle-root"), { recursive: true });
      },
      expected: (root: string) => path.join(root, "bundle-root"),
    },
    {
      name: "uses the extraction root when a root marker is present",
      setup: async (root: string) => {
        await fs.writeFile(path.join(root, "package.json"), "{}", "utf8");
      },
      opts: { rootMarkers: ["package.json"] },
      expected: (root: string) => root,
    },
  ])("resolves packed roots when $name", async ({ setup, expected, opts }) => {
    const root = await createTempDir();
    await setup(root);
    await expect(resolvePackedRootDir(root, opts)).resolves.toBe(expected(root));
  });

  it.each([
    {
      name: "multiple extracted roots exist",
      setup: async (root: string) => {
        await fs.mkdir(path.join(root, "a"), { recursive: true });
        await fs.mkdir(path.join(root, "b"), { recursive: true });
      },
    },
    {
      name: "only non-root marker files exist",
      setup: async (root: string) => {
        await fs.writeFile(path.join(root, "note.txt"), "hi", "utf8");
      },
    },
  ])("rejects unexpected packed root layouts when $name", async ({ setup }) => {
    const root = await createTempDir();
    await setup(root);
    await expect(resolvePackedRootDir(root)).rejects.toThrow(/unexpected archive layout/i);
  });

  it("returns work results and propagates errors before timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "extract zip")).resolves.toBe("ok");
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 100, "extract zip"),
    ).rejects.toThrow("boom");
  });

  it("rejects when archive work exceeds the timeout", async () => {
    vi.useFakeTimers();
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 50));
    const result = withTimeout(late, 1, "extract tar");
    const pending = expect(result).rejects.toThrow("extract tar timed out after 1ms");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("preflights tar entries for blocked link types, path escapes, and size budgets", () => {
    const checker = createTarEntryPreflightChecker({
      rootDir: "/tmp/dest",
      limits: {
        maxEntries: 1,
        maxEntryBytes: 8,
        maxExtractedBytes: 12,
      },
    });

    expectTarPreflightError(
      checker,
      { path: "package/link", type: "SymbolicLink", size: 0 },
      "tar entry is a link: package/link",
    );
    expectTarPreflightError(
      checker,
      { path: "../escape.txt", type: "File", size: 1 },
      /escapes destination|absolute/i,
    );

    checker({ path: "package/ok.txt", type: "File", size: 8 });
    expectTarPreflightError(
      checker,
      { path: "package/second.txt", type: "File", size: 1 },
      "archive entry count exceeds limit",
    );
  });

  it("treats stripped-away tar entries as no-ops and enforces extracted byte budgets", () => {
    const checker = createTarEntryPreflightChecker({
      rootDir: "/tmp/dest",
      stripComponents: 1,
      limits: {
        maxEntries: 4,
        maxEntryBytes: 16,
        maxExtractedBytes: 10,
      },
    });

    checker({ path: "package", type: "Directory", size: 0 });
    checker({ path: "package/a.txt", type: "File", size: 6 });
    expectTarPreflightError(
      checker,
      { path: "package/b.txt", type: "File", size: 6 },
      "archive extracted size exceeds limit",
    );
  });

  it("reads JSON files and reports file existence", async () => {
    const dir = await createTempDir();
    const jsonPath = path.join(dir, "data.json");
    const badPath = path.join(dir, "bad.json");
    await fs.writeFile(jsonPath, '{"ok":true}', "utf8");
    await fs.writeFile(badPath, "{not json", "utf8");

    await expect(readJsonFileStrict<{ ok: boolean }>(jsonPath)).resolves.toEqual({ ok: true });
    await expect(readJsonFileStrict(badPath)).rejects.toBeInstanceOf(JsonFileReadError);
    await expect(pathExists(jsonPath)).resolves.toBe(true);
    await expect(pathExists(path.join(dir, "missing.json"))).resolves.toBe(false);
  });
});
