import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
        await fs.writeFile(filePath, '{"ok":true}', "utf8");
        return filePath;
      },
      expected: { ok: true },
    },
    {
      name: "returns null for invalid files",
      setup: async (base: string) => {
        const filePath = path.join(base, "invalid.json");
        await fs.writeFile(filePath, "{not-json}", "utf8");
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
      await fs.writeFile(validPath, '{"ok":true}', "utf8");
      await fs.writeFile(invalidPath, "{not-json}", "utf8");

      await expect(readDurableJsonFile(validPath)).resolves.toEqual({ ok: true });
      await expect(readDurableJsonFile(missingPath)).resolves.toBeNull();
      await expect(readDurableJsonFile(invalidPath)).rejects.toMatchObject({
        filePath: invalidPath,
        reason: "parse",
      } satisfies Partial<JsonFileReadError>);
    });
  });

  it("writes json atomically with pretty formatting and optional trailing newline", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "nested", "config.json");

      await writeJsonAtomic(
        filePath,
        { ok: true, nested: { value: 1 } },
        { trailingNewline: true, ensureDirMode: 0o755 },
      );

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
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
      await writeTextAtomic(filePath, input, { appendTrailingNewline: true });
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(expected);
    });
  });

  it("falls back to copy-on-replace for Windows rename EPERM", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      await fs.writeFile(filePath, "old", "utf8");

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const renameError = Object.assign(new Error("EPERM"), { code: "EPERM" });
      const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(renameError);
      const copySpy = vi.spyOn(fs, "copyFile");

      await writeTextAtomic(filePath, "new");

      expect(renameSpy).toHaveBeenCalledOnce();
      expect(copySpy).toHaveBeenCalledOnce();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
    });
  });

  it("replaces symlink targets instead of writing through them on Windows rename fallback", async () => {
    await withTempDir({ prefix: "openclaw-json-files-" }, async (base) => {
      const filePath = path.join(base, "state.json");
      const outsidePath = path.join(base, "outside.json");
      await fs.writeFile(outsidePath, "outside", "utf8");
      await fs.symlink(outsidePath, filePath);

      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const renameError = Object.assign(new Error("EPERM"), { code: "EPERM" });
      vi.spyOn(fs, "rename").mockRejectedValueOnce(renameError);

      await writeTextAtomic(filePath, "new");

      await expect(fs.lstat(filePath)).resolves.toSatisfy((stat) => !stat.isSymbolicLink());
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    });
  });

  it.each([
    {
      name: "serializes async lock callers even across rejections",
      firstTask: async (events: string[]) => {
        events.push("first:start");
        await sleep(20);
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
