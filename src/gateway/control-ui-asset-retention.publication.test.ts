import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

describe("Control UI retained publication", () => {
  it.each(["removed", "replaced-valid", "symlink"] as const)(
    "rechecks a %s current target before refreshing it",
    async (mutation) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const current = await seed("current");
        const sibling = await seed("sibling");
        const outside = path.join(root, "outside");
        await fs.cp(current.root, outside, { recursive: true });
        await fs.utimes(outside, 1_700_000_100, 1_700_000_100);
        const outsideBefore = await fs.stat(outside);
        const contents = await fs.readFile(path.join(current.root, current.assetPath));
        const targetAsset = path.join(current.target, current.assetPath);
        const siblingAsset = path.join(sibling.target, sibling.assetPath);
        const reads = new Map([
          [targetAsset, 0],
          [siblingAsset, 0],
        ]);
        const refreshReads: number[] = [];
        const readFile = fs.readFile;
        const utimes = fs.utimes;
        let mutated = false;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await readFile(...args);
          const file = args[0];
          if (typeof file === "string" && reads.has(file)) {
            reads.set(file, reads.get(file)! + 1);
          }
          if (!mutated && file === path.join(current.root, "asset-manifest.json")) {
            mutated = true;
            if (mutation === "removed") {
              await fs.rm(current.target, { recursive: true });
            } else {
              await fs.rename(current.target, path.join(root, "displaced"));
              if (mutation === "replaced-valid") {
                await fs.cp(current.root, current.target, { recursive: true });
              } else {
                await fs.symlink(outside, current.target, "dir");
              }
            }
          }
          return result;
        });
        vi.spyOn(fs, "utimes").mockImplementation(async (...args) => {
          if (args[0] === current.target) {
            refreshReads.push(reads.get(targetAsset)!);
          }
          return utimes(...args);
        });
        const owner = createControlUiAssetRetention(current.root);
        if (mutation === "symlink") {
          await expect(owner.prepare()).rejects.toThrow();
          expect(refreshReads).toEqual([]);
        } else {
          await owner.prepare();
          expect(owner.resolveAsset(current.assetPath)?.filePath).toBe(targetAsset);
          expect(refreshReads).toEqual([2]);
          expect(reads.get(targetAsset)).toBe(2);
        }
        expect(mutated).toBe(true);
        expect(reads.get(siblingAsset)).toBe(1);
        vi.restoreAllMocks();
        expect(await fs.readFile(targetAsset)).toEqual(contents);
        expect(await fs.readFile(path.join(outside, current.assetPath))).toEqual(contents);
        expect((await fs.stat(outside)).mtimeMs).toBe(outsideBefore.mtimeMs);
        expect((await fs.readdir(cache)).toSorted()).toEqual(
          [current.manifest.generation, sibling.manifest.generation].toSorted(),
        );
      });
    },
  );

  it.each(["same", "different"] as const)(
    "coordinates native concurrent %s-target publication without losing the winner",
    async (kind) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const old = [await seed("old-a"), await seed("old-b")];
        const a = await writeRetentionBuild(path.join(root, "a"), "a");
        const b = kind === "same" ? a : await writeRetentionBuild(path.join(root, "b"), "b");
        const owners = [
          createControlUiAssetRetention(a.root),
          createControlUiAssetRetention(b.root),
        ];
        const barrier = createDeferred();
        let arrivals = 0;
        const rename = fs.rename;
        const errors: string[] = [];
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          // Both preparers reach real rename from their own completed staging tree.
          if (++arrivals === 2) {
            barrier.resolve();
          }
          await barrier.promise;
          try {
            await rename(...args);
          } catch (error) {
            errors.push((error as NodeJS.ErrnoException).code!);
            throw error;
          }
        });
        const results = await Promise.allSettled(owners.map((owner) => owner.prepare()));
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
        expect(arrivals).toBe(2);
        if (kind === "same") {
          expect(errors).toHaveLength(1);
          expect(["EEXIST", "ENOTEMPTY"]).toContain(errors[0]);
        } else {
          expect(errors).toEqual([]);
        }
        for (const [index, owner] of owners.entries()) {
          const build = index === 0 ? a : b;
          expect(
            await fs.readFile(owner.resolveAsset(build.assetPath)!.filePath, "utf8"),
          ).toContain(index === 0 || kind === "same" ? '"a"' : '"b"');
        }
        const entries = await fs.readdir(cache);
        expect(entries).toHaveLength(3);
        expect(entries.some((entry) => entry.startsWith(".staging-"))).toBe(false);
        if (kind === "different") {
          expect(entries).toContain(a.manifest.generation);
          expect(entries).toContain(b.manifest.generation);
          expect(old.filter((build) => entries.includes(build.manifest.generation))).toHaveLength(
            1,
          );
        }
      });
    },
  );

  it.each([
    ["EEXIST", "valid"],
    ["ENOTEMPTY", "valid"],
    ["EEXIST", "digest"],
    ["ENOTEMPTY", "digest"],
    ["EEXIST", "manifest"],
    ["ENOTEMPTY", "manifest"],
    ["EEXIST", "symlink"],
    ["ENOTEMPTY", "symlink"],
    ["EACCES", "valid"],
  ] as const)("handles %s only when its exact winner is %s", async (code, integrity) => {
    await withRetentionFixture(async ({ root, cache }) => {
      const build = await writeRetentionBuild(path.join(root, "build"), "winner");
      const target = path.join(cache, build.manifest.generation);
      const collision = Object.assign(new Error("rename failed"), { code });
      vi.spyOn(fs, "rename").mockImplementation(async () => {
        if (integrity === "symlink") {
          await fs.symlink(build.root, target, "dir");
        } else {
          await fs.cp(build.root, target, { recursive: true });
          if (integrity === "digest") {
            await fs.writeFile(
              path.join(target, build.assetPath),
              Buffer.alloc(build.manifest.assets[0]!.size, 120),
            );
          }
          if (integrity === "manifest") {
            await fs.writeFile(path.join(target, "asset-manifest.json"), "{");
          }
        }
        throw collision;
      });
      const owner = createControlUiAssetRetention(build.root);
      if (integrity === "valid" && code !== "EACCES") {
        await owner.prepare();
        expect(owner.resolveAsset(build.assetPath)?.filePath).toBe(
          path.join(target, build.assetPath),
        );
      } else {
        await expect(owner.prepare()).rejects.toBe(collision);
        expect(owner.resolveAsset(build.assetPath)).toBeNull();
      }
      // A failed loser owns its staging only, including when the winner is invalid.
      expect(await fs.readdir(cache)).toEqual([build.manifest.generation]);
    });
  });

  it("verifies its newly published target before adopting it", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      const build = await writeRetentionBuild(path.join(root, "build"), "new");
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        await fs.writeFile(
          path.join(cache, build.manifest.generation, build.assetPath),
          Buffer.alloc(build.manifest.assets[0]!.size, 120),
        );
      });
      const owner = createControlUiAssetRetention(build.root);
      await expect(owner.prepare()).rejects.toThrow("Invalid retained Control UI generation");
      expect(owner.resolveAsset(build.assetPath)).toBeNull();
      expect(await fs.readdir(cache)).toEqual([build.manifest.generation]);
    });
  });

  it("revalidates a replaced directory instead of trusting an old verified record", async () => {
    await withRetentionFixture(async ({ root, seed }) => {
      const old = await seed("old");
      const build = await writeRetentionBuild(path.join(root, "build"), "new");
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const result = await readFile(...args);
        if (args[0] === path.join(build.root, "asset-manifest.json")) {
          await fs.rename(old.target, path.join(root, "previous-inode"));
          await fs.cp(old.root, old.target, { recursive: true });
          await fs.writeFile(
            path.join(old.target, old.assetPath),
            Buffer.alloc(old.manifest.assets[0]!.size, 120),
          );
        }
        return result;
      });
      const owner = createControlUiAssetRetention(build.root);
      await owner.prepare();
      expect(owner.resolveAsset(old.assetPath)).toBeNull();
      expect(owner.resolveAsset(build.assetPath)).not.toBeNull();
      await expect(fs.access(old.target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["replace-evicted", "remove-survivor"] as const)(
    "respects a concurrent %s after its pruning inventory",
    async (mutation) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const current = await seed("current");
        const history = [await seed("a"), await seed("b"), await seed("c")].toSorted((a, b) =>
          a.manifest.generation.localeCompare(b.manifest.generation),
        );
        const victim = mutation === "replace-evicted" ? history[2]! : history[0]!;
        const stale = path.join(cache, ".staging-1-aaaa");
        await fs.mkdir(stale);
        await fs.utimes(stale, 0, 0);
        const rm = fs.rm;
        let raced = false;
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          await rm(...args);
          if (args[0] === stale) {
            raced = true;
            await fs.rename(victim.target, path.join(root, "concurrently-removed"));
            if (mutation === "replace-evicted") {
              await fs.cp(victim.root, victim.target, { recursive: true });
            }
          }
        });
        const owner = createControlUiAssetRetention(current.root);
        await owner.prepare();
        expect(raced).toBe(true);
        expect(owner.resolveAsset(victim.assetPath)).toBeNull();
        expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
        expect(
          await fs.access(victim.target).then(
            () => true,
            () => false,
          ),
        ).toBe(mutation === "replace-evicted");
      });
    },
  );
});
