// Covers durable JSON read/write helpers, parse failures, and atomic update behavior.
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  JsonFileReadError,
  createAsyncLock,
  readDurableJsonFile,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
} from "./json-files.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("json file helpers", () => {
  it.each([
    {
      name: "reads valid json",
      setup: async (base: string) => {
        const filePath = path.join(base, "valid.json");
        await fsPromises.writeFile(filePath, '{"ok":true}', "utf8");
        return filePath;
      },
      expected: { ok: true },
    },
    {
      name: "returns null for invalid files",
      setup: async (base: string) => {
        const filePath = path.join(base, "invalid.json");
        await fsPromises.writeFile(filePath, "{not-json}", "utf8");
        return filePath;
      },
      expected: null,
    },
    {
      name: "returns null for missing files",
      setup: async (base: string) => path.join(base, "missing.json"),
      expected: null,
    },
  ])("$name", async ({ setup, expected }) => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      await expect(readJsonFile(await setup(base))).resolves.toEqual(expected);
    });
  });

  it("reads durable json strictly while allowing missing files", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const validPath = path.join(base, "valid.json");
      const invalidPath = path.join(base, "invalid.json");
      const missingPath = path.join(base, "missing.json");
      await fsPromises.writeFile(validPath, '{"ok":true}', "utf8");
      await fsPromises.writeFile(invalidPath, "{not-json}", "utf8");

      await expect(readDurableJsonFile(validPath)).resolves.toEqual({ ok: true });
      await expect(readDurableJsonFile(missingPath)).resolves.toBeNull();
      let readError: unknown;
      try {
        await readDurableJsonFile(invalidPath);
      } catch (error) {
        readError = error;
      }
      expect((readError as JsonFileReadError | undefined)?.filePath).toBe(invalidPath);
      expect((readError as JsonFileReadError | undefined)?.reason).toBe("parse");
    });
  });

  it("writes json atomically with pretty formatting and optional trailing newline", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "nested", "config.json");

      await writeJsonAtomic(
        filePath,
        { ok: true, nested: { value: 1 } },
        { trailingNewline: true, dirMode: 0o755 },
      );

      await expect(fsPromises.readFile(filePath, "utf8")).resolves.toBe(
        '{\n  "ok": true,\n  "nested": {\n    "value": 1\n  }\n}\n',
      );
    });
  });

  it.each([
    { input: "hello", expected: "hello\n" },
    { input: "hello\n", expected: "hello\n" },
  ])("writes text atomically for %j", async ({ input, expected }) => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "nested", "note.txt");
      await writeTextAtomic(filePath, input, { trailingNewline: true });
      await expect(fsPromises.readFile(filePath, "utf8")).resolves.toBe(expected);
    });
  });

  it("can skip durable fsync work for hot state writes", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      const openSpy = vi.spyOn(fsPromises, "open");

      await writeTextAtomic(filePath, "new", { durable: false });

      expect(openSpy).not.toHaveBeenCalled();
      await expect(fsPromises.readFile(filePath, "utf8")).resolves.toBe("new");
    });
  });

  it("preserves text when Windows rename reports EPERM", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      await fsPromises.writeFile(filePath, "old", "utf8");

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const renameError = Object.assign(new Error("EPERM"), { code: "EPERM" });
      const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(renameError);

      await writeTextAtomic(filePath, "new");

      expect(renameSpy).toHaveBeenCalledOnce();
      await expect(fsPromises.readFile(filePath, "utf8")).resolves.toBe("new");
    });
  });

  it("stages the atomic temp with a caller-provided prefix (#56827)", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "sessions.json");
      // Spy without mocking: rename is still performed, but we capture the staged
      // temp path (its source) to confirm the prefix is applied.
      const renameSpy = vi.spyOn(fsPromises, "rename");

      await writeTextAtomic(filePath, "new", { tempPrefix: path.basename(filePath) });

      await expect(fsPromises.readFile(filePath, "utf8")).resolves.toBe("new");
      const stagedTemps = renameSpy.mock.calls.map((call) => path.basename(String(call[0])));
      // The orphan a crash would leave is now identifiable as a session-store temp.
      expect(
        stagedTemps.some((name) =>
          /^sessions\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(
            name,
          ),
        ),
      ).toBe(true);
      expect(stagedTemps.some((name) => name.startsWith(".fs-safe-replace"))).toBe(false);
    });
  });

  it("refuses Windows copy fallback through symlink destinations", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      const outsidePath = path.join(base, "outside.json");
      await fsPromises.writeFile(outsidePath, "outside", "utf8");
      await fsPromises.symlink(outsidePath, filePath);

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const renameError = Object.assign(new Error("EPERM"), { code: "EPERM" });
      vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(renameError);

      await expect(writeTextAtomic(filePath, "new")).rejects.toThrow(
        "Refusing copy fallback through symlink destination",
      );

      const fileStat = await fsPromises.lstat(filePath);
      expect(fileStat.isSymbolicLink()).toBe(true);
      await expect(fsPromises.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    });
  });

  it.each([
    {
      name: "serializes async lock callers even across rejections",
      firstTask: async (events: string[]) => {
        events.push("first:start");
        await Promise.resolve();
        events.push("first:end");
        throw new Error("boom");
      },
      expectedFirstError: "boom",
      expectedEvents: ["first:start", "first:end", "second:start", "second:end"],
    },
    {
      name: "releases the async lock after synchronous throws",
      firstTask: async (events: string[]) => {
        events.push("first:start");
        throw new Error("sync boom");
      },
      expectedFirstError: "sync boom",
      expectedEvents: ["first:start", "second:start", "second:end"],
    },
  ])("$name", async ({ firstTask, expectedFirstError, expectedEvents }) => {
    const withLock = createAsyncLock();
    const events: string[] = [];

    const first = withLock(() => firstTask(events));

    const second = withLock(async () => {
      events.push("second:start");
      events.push("second:end");
      return "ok";
    });

    await expect(first).rejects.toThrow(expectedFirstError);
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(expectedEvents);
  });
});
