import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

const boundaries = [
  "before-start",
  "retained-read",
  "source-read",
  "asset-write",
  "manifest-write",
  "rename-issued",
  "refresh",
  "prune-issued",
  "projection",
] as const;

describe.each(["signal", "predicate"] as const)(
  "Control UI retention cancellation by %s",
  (mode) => {
    it.each(boundaries)("stops at %s and cleans only its staging", async (boundary) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const old = await seed("old");
        const build =
          boundary === "refresh"
            ? old
            : await writeRetentionBuild(path.join(root, "current"), "current");
        const target = path.join(cache, build.manifest.generation);
        const stale = [".staging-1-aaaa", ".staging-2-bbbb"].map((name) => path.join(cache, name));
        for (const directory of stale) {
          await fs.mkdir(directory);
          await fs.utimes(directory, 0, 0);
        }
        const owner = createControlUiAssetRetention(build.root);
        const controller = new AbortController();
        let cancelled = false;
        let published = false;
        const pruned = new Set<string>();
        const cancel = () => {
          cancelled = true;
          if (mode === "signal") {
            controller.abort();
          }
        };
        const original = {
          readFile: fs.readFile,
          writeFile: fs.writeFile,
          open: fs.open,
          rename: fs.rename,
          lstat: fs.lstat,
          rm: fs.rm,
        };
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await original.readFile(...args);
          if (
            (boundary === "retained-read" && args[0] === path.join(old.target, old.assetPath)) ||
            (boundary === "refresh" && args[0] === path.join(build.root, "asset-manifest.json"))
          ) {
            cancel();
          }
          return result;
        });
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await original.open(...args);
          const read = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => {
            const result = await read(...readArgs);
            if (boundary === "source-read") {
              cancel();
            }
            return result;
          });
          return handle;
        });
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          await original.writeFile(...args);
          const file = args[0];
          if (
            boundary === "asset-write" &&
            typeof file === "string" &&
            file.includes(".staging-") &&
            file.endsWith(build.assetPath)
          ) {
            cancel();
          }
          if (
            boundary === "manifest-write" &&
            typeof file === "string" &&
            file.includes(".staging-") &&
            file.endsWith("/asset-manifest.json")
          ) {
            cancel();
          }
        });
        const renames = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          await original.rename(...args);
          published = true;
          if (boundary === "rename-issued") {
            cancel();
          }
        });
        const refreshes = vi.spyOn(fs, "utimes");
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await original.lstat(...args);
          if (boundary === "projection" && pruned.size > 0 && args[0] === target) {
            cancel();
          }
          return result;
        });
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          await original.rm(...args);
          const directory = args[0];
          if (typeof directory === "string" && stale.includes(directory)) {
            pruned.add(directory);
            if (boundary === "prune-issued") {
              cancel();
            }
          }
        });
        if (boundary === "before-start") {
          cancel();
        }
        await expect(
          owner.prepare(
            mode === "signal" ? { signal: controller.signal } : { isCancelled: () => cancelled },
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(cancelled).toBe(true);
        expect(published).toBe(["rename-issued", "prune-issued", "projection"].includes(boundary));
        expect(pruned.size).toBe(
          boundary === "projection" ? 2 : boundary === "prune-issued" ? 1 : 0,
        );
        expect(renames).toHaveBeenCalledTimes(published ? 1 : 0);
        expect(refreshes).toHaveBeenCalledTimes(
          ["prune-issued", "projection"].includes(boundary) ? 1 : 0,
        );
        vi.restoreAllMocks();
        expect(
          (await fs.readdir(cache)).filter(
            (name) => name.startsWith(".staging-") && !stale.includes(path.join(cache, name)),
          ),
        ).toEqual([]);
        for (const directory of stale) {
          expect(
            await fs.access(directory).then(
              () => true,
              () => false,
            ),
          ).toBe(!pruned.has(directory));
        }
        expect(await fs.readFile(path.join(old.target, old.assetPath), "utf8")).toContain("old");
        if (boundary !== "refresh") {
          expect(owner.resolveAsset(build.assetPath)).toBeNull();
          expect(
            await fs.access(target).then(
              () => true,
              () => false,
            ),
          ).toBe(published);
        }
      });
    });
  },
);
