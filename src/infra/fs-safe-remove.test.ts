import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createRebindableDirectoryAlias } from "../test-utils/symlink-rebind-race.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { removePathWithinRoot } from "./fs-safe-remove.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await tempDirs.cleanup();
});

async function expectRejectCode(promise: Promise<unknown>, expected: string | RegExp) {
  const err = await promise.catch((caught: unknown) => caught);
  if (err === undefined) {
    throw new Error("Expected promise to reject");
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof expected === "string") {
    expect(code).toBe(expected);
  } else {
    expect(code).toMatch(expected);
  }
}

describe("removePathWithinRoot", () => {
  it("removes a file within root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "shared.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "hello");

    await removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("nested", "shared.txt"),
      force: false,
    });

    await expectRejectCode(fs.stat(targetPath), "ENOENT");
  });

  it("removes an empty directory within root", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetPath = path.join(root, "nested", "empty");
    await fs.mkdir(targetPath, { recursive: true });

    await removePathWithinRoot({
      rootDir: root,
      relativePath: path.join("nested", "empty"),
      force: false,
    });

    await expectRejectCode(fs.stat(targetPath), "ENOENT");
  });

  it("rejects non-recursive removal of non-empty directories", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const targetDir = path.join(root, "nested");
    const childPath = path.join(targetDir, "child.txt");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(childPath, "hello");

    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "nested",
        force: true,
      }),
      /ENOTEMPTY|EEXIST|EPERM/,
    );
    await expect(fs.readFile(childPath, "utf8")).resolves.toBe("hello");
  });

  it("removes directory trees recursively", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    await fs.mkdir(path.join(root, "tree", "b-dir"), { recursive: true });
    await fs.mkdir(path.join(root, "tree", "a-dir", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "tree", "b-dir", "b.txt"), "b");
    await fs.writeFile(path.join(root, "tree", "a-dir", "nested", "a.txt"), "a");

    await removePathWithinRoot({
      rootDir: root,
      relativePath: "tree",
      recursive: true,
      force: false,
    });

    await expectRejectCode(fs.stat(path.join(root, "tree")), "ENOENT");
  });

  it("suppresses only not-found errors when force is enabled", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");

    await expect(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "missing.txt",
      }),
    ).resolves.toBeUndefined();
    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "missing.txt",
        force: false,
      }),
      "not-found",
    );
  });

  it("rejects symlink and junction targets", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-root-");
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, "target.txt"), "hello");
    await createRebindableDirectoryAlias({
      aliasPath: aliasDir,
      targetPath: realDir,
    });

    await expectRejectCode(
      removePathWithinRoot({
        rootDir: root,
        relativePath: "alias",
        recursive: true,
        force: true,
      }),
      "symlink",
    );
    await expect(fs.readFile(path.join(realDir, "target.txt"), "utf8")).resolves.toBe("hello");
  });

  it.runIf(process.platform === "win32")(
    "fails closed when the fallback remove path is rebound during recursive removal",
    async () => {
      const root = await tempDirs.make("openclaw-fs-safe-root-");
      const nestedDir = path.join(root, "tree", "nested");
      const leafPath = path.join(nestedDir, "leaf.txt");
      const outside = await tempDirs.make("openclaw-fs-safe-outside-");
      const outsideFile = path.join(outside, "outside.txt");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(leafPath, "leaf");
      await fs.writeFile(outsideFile, "outside");
      let rebound = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (rebound || operation !== "remove" || targetPath !== leafPath) {
            return;
          }
          rebound = true;
          await createRebindableDirectoryAlias({
            aliasPath: nestedDir,
            targetPath: outside,
          });
        },
      });

      await expectRejectCode(
        removePathWithinRoot({
          rootDir: root,
          relativePath: "tree",
          recursive: true,
          force: true,
        }),
        /path-mismatch|path-alias|outside-workspace|invalid-path|not-found|not-file|ENOENT|EPERM/,
      );

      expect(rebound).toBe(true);
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    },
  );
});
