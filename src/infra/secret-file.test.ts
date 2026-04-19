import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  readSecretFileSync,
  tryReadSecretFileSync,
  writePrivateSecretFileAtomic,
} from "./secret-file.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-secret-file-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

async function expectSecretFileError(params: {
  setup: (dir: string) => Promise<string>;
  expectedMessage: (file: string) => string;
  secretLabel?: string;
  options?: Parameters<typeof readSecretFileSync>[2];
}): Promise<void> {
  const dir = await createTempDir();
  const file = await params.setup(dir);
  expect(() =>
    readSecretFileSync(file, params.secretLabel ?? "Gateway password", params.options),
  ).toThrow(params.expectedMessage(file));
}

async function createSecretPath(setup: (dir: string) => Promise<string>): Promise<string> {
  const dir = await createTempDir();
  return setup(dir);
}

describe("readSecretFileSync", () => {
  it("rejects blank file paths", () => {
    expect(() => readSecretFileSync("   ", "Gateway password")).toThrow(
      "Gateway password file path is empty.",
    );
  });

  it("reads and trims a regular secret file", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "secret.txt");
    await fsPromises.writeFile(file, " top-secret \n", "utf8");

    expect(readSecretFileSync(file, "Gateway password")).toBe("top-secret");
    expect(tryReadSecretFileSync(file, "Gateway password")).toBe("top-secret");
  });

  it.each([
    {
      name: "surfaces resolvedPath and error details for missing files",
      assert: (file: string) => {
        expect(loadSecretFileSync(file, "Gateway password")).toMatchObject({
          ok: false,
          resolvedPath: file,
          message: expect.stringContaining(`Failed to inspect Gateway password file at ${file}:`),
          error: expect.any(Error),
        });
      },
    },
    {
      name: "preserves the underlying cause when throwing for missing files",
      assert: (file: string) => {
        let thrown: Error | undefined;
        try {
          readSecretFileSync(file, "Gateway password");
        } catch (error) {
          thrown = error as Error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown?.message).toContain(`Failed to inspect Gateway password file at ${file}:`);
        expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      },
    },
  ])("$name", async ({ assert }) => {
    const file = await createSecretPath(async (dir) => path.join(dir, "missing-secret.txt"));
    assert(file);
  });

  it.each([
    {
      name: "rejects files larger than the secret-file limit",
      setup: async (dir: string) => {
        const file = path.join(dir, "secret.txt");
        await fsPromises.writeFile(file, "x".repeat(DEFAULT_SECRET_FILE_MAX_BYTES + 1), "utf8");
        return file;
      },
      expectedMessage: (file: string) =>
        `Gateway password file at ${file} exceeds ${DEFAULT_SECRET_FILE_MAX_BYTES} bytes.`,
    },
    {
      name: "rejects non-regular files",
      setup: async (dir: string) => {
        const nestedDir = path.join(dir, "secret-dir");
        await fsPromises.mkdir(nestedDir);
        return nestedDir;
      },
      expectedMessage: (file: string) => `Gateway password file at ${file} must be a regular file.`,
    },
    {
      name: "rejects symlinks when configured",
      setup: async (dir: string) => {
        const target = path.join(dir, "target.txt");
        const link = path.join(dir, "secret-link.txt");
        await fsPromises.writeFile(target, "top-secret\n", "utf8");
        await fsPromises.symlink(target, link);
        return link;
      },
      options: { rejectSymlink: true },
      expectedMessage: (file: string) => `Gateway password file at ${file} must not be a symlink.`,
    },
    {
      name: "rejects empty secret files after trimming",
      setup: async (dir: string) => {
        const file = path.join(dir, "secret.txt");
        await fsPromises.writeFile(file, " \n\t ", "utf8");
        return file;
      },
      expectedMessage: (file: string) => `Gateway password file at ${file} is empty.`,
    },
  ])("$name", async ({ setup, expectedMessage, options }) => {
    await expectSecretFileError({ setup, expectedMessage, options });
  });

  it.each([
    {
      name: "exposes resolvedPath on non-throwing read failures",
      pathValue: async () =>
        createSecretPath(async (dir) => {
          const file = path.join(dir, "secret.txt");
          await fsPromises.writeFile(file, " \n\t ", "utf8");
          return file;
        }),
      label: "Gateway password",
      options: undefined,
      helper: "load" as const,
      expected: (file: string | undefined) => ({
        ok: false,
        resolvedPath: file,
        message: `Gateway password file at ${file} is empty.`,
      }),
    },
    {
      name: "returns undefined from the non-throwing helper for rejected files",
      pathValue: async () =>
        createSecretPath(async (dir) => {
          const target = path.join(dir, "target.txt");
          const link = path.join(dir, "secret-link.txt");
          await fsPromises.writeFile(target, "top-secret\n", "utf8");
          await fsPromises.symlink(target, link);
          return link;
        }),
      label: "Telegram bot token",
      options: { rejectSymlink: true },
      helper: "try" as const,
      expected: () => undefined,
    },
    {
      name: "returns undefined from the non-throwing helper for blank file paths",
      pathValue: async () => "   ",
      label: "Telegram bot token",
      options: undefined,
      helper: "try" as const,
      expected: () => undefined,
    },
    {
      name: "returns undefined from the non-throwing helper for missing path values",
      pathValue: async () => undefined,
      label: "Telegram bot token",
      options: undefined,
      helper: "try" as const,
      expected: () => undefined,
    },
  ])("$name", async ({ pathValue, label, options, helper, expected }) => {
    const file = await pathValue();
    if (helper === "load") {
      expect(loadSecretFileSync(file as string, label, options)).toMatchObject(
        (expected as (file: string | undefined) => Record<string, unknown>)(file),
      );
      return;
    }
    expect(tryReadSecretFileSync(file, label, options)).toBe((expected as () => undefined)());
  });
});

describe("writePrivateSecretFileAtomic", () => {
  it("writes a private file with owner-only permissions", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "nested", "auth.json");

    await writePrivateSecretFileAtomic({
      rootDir: dir,
      filePath: file,
      content: '{"ok":true}\n',
    });

    expect(loadSecretFileSync(file, "Gateway password")).toMatchObject({
      ok: true,
      secret: '{"ok":true}',
    });
    if (process.platform !== "win32") {
      const dirStat = await fsPromises.stat(path.dirname(file));
      const fileStat = await fsPromises.stat(file);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
    }
  });

  it("rejects symlinked target files", async () => {
    const dir = await createTempDir();
    const nestedDir = path.join(dir, "nested");
    const target = path.join(dir, "outside.txt");
    const link = path.join(nestedDir, "auth.json");
    await fsPromises.mkdir(nestedDir);
    await fsPromises.writeFile(target, "outside", "utf8");
    await fsPromises.symlink(target, link);

    await expect(
      writePrivateSecretFileAtomic({
        rootDir: dir,
        filePath: link,
        content: '{"ok":true}\n',
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  it("rejects symlinked path components", async () => {
    const dir = await createTempDir();
    const targetDir = path.join(dir, "outside-dir");
    await fsPromises.mkdir(targetDir);
    await fsPromises.symlink(targetDir, path.join(dir, "linked"));

    await expect(
      writePrivateSecretFileAtomic({
        rootDir: dir,
        filePath: path.join(dir, "linked", "auth.json"),
        content: '{"ok":true}\n',
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  it("tightens an existing world-readable directory before writing secrets", async () => {
    const dir = await createTempDir();
    const nestedDir = path.join(dir, "nested");
    await fsPromises.mkdir(nestedDir, { mode: 0o777 });
    if (process.platform !== "win32") {
      await writePrivateSecretFileAtomic({
        rootDir: dir,
        filePath: path.join(nestedDir, "auth.json"),
        content: '{"ok":true}\n',
      });
      const dirStat = await fsPromises.stat(nestedDir);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
    }
  });

  it("rejects a parent directory symlink before it can escape the private root", async () => {
    const dir = await createTempDir();
    const targetDir = await createTempDir();
    const aliasDir = path.join(dir, "nested");
    await fsPromises.symlink(targetDir, aliasDir);

    await expect(
      writePrivateSecretFileAtomic({
        rootDir: dir,
        filePath: path.join(aliasDir, "auth.json"),
        content: '{"ok":true}\n',
      }),
    ).rejects.toThrow("must not be a symlink");
  });
});
