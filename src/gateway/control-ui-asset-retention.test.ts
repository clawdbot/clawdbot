import crypto from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { CONTROL_UI_ASSET_MANIFEST_FILENAME } from "./control-ui-asset-manifest.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  createRetentionManifest,
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

describe("Control UI asset retention", () => {
  it("verifies each retained asset once per preparation", async () => {
    const fixture = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retention-io-")),
    );
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture, "state") }, async () => {
        const retainedPaths = new Set<string>();
        let expectedBytes = 0;
        let root = "";
        for (const label of ["a", "b", "c"]) {
          root = path.join(fixture, label);
          const { assetPath: asset } = await writeRetentionBuild(root, label);
          const owner = createControlUiAssetRetention(root);
          await owner.prepare();
          const retained = owner.resolveAsset(asset)!;
          retainedPaths.add(retained.filePath);
          expectedBytes += (await fs.stat(retained.filePath)).size;
        }
        const counts = { lstats: 0, reads: 0, readBytes: 0, hashes: 0, hashBytes: 0 };
        const buffers = new WeakSet<object>();
        const readFile = fs.readFile;
        const lstat = fs.lstat;
        const hash = crypto.createHash;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (typeof args[0] === "string" && retainedPaths.has(args[0])) {
            counts.lstats++;
          }
          return lstat(...args);
        });
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await readFile(...args);
          if (
            typeof args[0] === "string" &&
            retainedPaths.has(args[0]) &&
            Buffer.isBuffer(result)
          ) {
            counts.reads++;
            counts.readBytes += result.byteLength;
            buffers.add(result);
          }
          return result;
        });
        vi.spyOn(crypto, "createHash").mockImplementation((...args) => {
          const instance = hash(...args);
          const update = instance.update.bind(instance);
          instance.update = (data, ...rest) => {
            if (typeof data === "object" && buffers.has(data)) {
              counts.hashes++;
              counts.hashBytes += data.byteLength;
            }
            return update(data, ...rest);
          };
          return instance;
        });
        syncBuiltinESMExports();
        const owner = createControlUiAssetRetention(root);
        try {
          await owner.prepare();
        } finally {
          vi.restoreAllMocks();
          syncBuiltinESMExports();
        }
        expect(counts).toEqual({
          lstats: 3,
          reads: 3,
          readBytes: expectedBytes,
          hashes: 3,
          hashBytes: expectedBytes,
        });
        for (const retained of retainedPaths) {
          expect(owner.resolveAsset(`assets/${path.basename(retained)}`)?.filePath).toBe(retained);
        }
      });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps the current and two prior generations with deterministic mtime ties", async () => {
    await withRetentionFixture(async ({ seed, cache }) => {
      const builds = [await seed("a"), await seed("b"), await seed("c"), await seed("d")] as const;
      const [current, ...previous] = builds;
      const future = new Date("2099-01-01T00:00:00Z");
      for (const build of previous) {
        await fs.utimes(build.target, future, future);
      }
      const expected = previous
        .toSorted((a, b) => a.manifest.generation.localeCompare(b.manifest.generation))
        .slice(0, 2);
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();
      expect((await fs.readdir(cache)).toSorted()).toEqual(
        [current, ...expected].map((b) => b.manifest.generation).toSorted(),
      );
      for (const build of builds) {
        const kept = build === current || expected.includes(build);
        expect(owner.resolveAsset(build.assetPath) !== null).toBe(kept);
      }
    });
  });

  it("enforces the exact aggregate 96 MiB edge and gives current bytes priority", async () => {
    await withRetentionFixture(async ({ seed, cache }) => {
      const older = await seed("a", { size: 48 * 1024 * 1024 });
      const current = await seed("b", { size: 48 * 1024 * 1024 });
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();
      expect(owner.resolveAsset(older.assetPath)).not.toBeNull();
      expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
      expect(await fs.readdir(cache)).toHaveLength(2);
      const tiny = await seed("c", { size: 1 });
      const next = createControlUiAssetRetention(tiny.root);
      await next.prepare();
      expect(next.resolveAsset(older.assetPath)).toBeNull();
      expect(next.resolveAsset(current.assetPath)).not.toBeNull();
      expect(next.resolveAsset(tiny.assetPath)).not.toBeNull();
      expect(await fs.readdir(cache)).toHaveLength(2);
    });
  });

  it("projects survivors by mtime even when selection prioritizes the current generation", async () => {
    await withRetentionFixture(async ({ seed }) => {
      const previous = await seed("previous", { assetPath: "assets/shared.js" });
      const current = await seed("current", { assetPath: "assets/shared.js" });
      const future = new Date("2099-01-01T00:00:00Z");
      await fs.utimes(previous.target, future, future);
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();
      expect(owner.resolveAsset(current.assetPath)?.filePath).toBe(
        path.join(previous.target, previous.assetPath),
      );
    });
  });

  it("publishes through a symlinked state-directory ancestor using the canonical retained root", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      const alias = path.join(root, "alias");
      await fs.symlink(root, alias, "dir");
      const build = await writeRetentionBuild(path.join(root, "build"), "current");
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(alias, "state") }, async () => {
        const owner = createControlUiAssetRetention(build.root);
        await owner.prepare();
        expect(owner.resolveAsset(build.assetPath)?.rootRealPath).toBe(
          path.join(cache, build.manifest.generation),
        );
      });
    });
  });

  it("defers verification, exposes verified fallback during copy failure, and retries rejected preparation", async () => {
    await withRetentionFixture(async ({ root, seed, cache }) => {
      const old = await seed("old");
      const current = await writeRetentionBuild(path.join(root, "current"), "current", {
        corrupt: true,
      });
      const owner = createControlUiAssetRetention(current.root);
      expect(owner.resolveAsset(old.assetPath)).toBeNull();
      const open = fs.open;
      const observed = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        expect(owner.resolveAsset(old.assetPath)?.filePath).toBe(
          path.join(old.target, old.assetPath),
        );
        return open(...args);
      });
      const preparing = owner.prepare();
      expect(owner.prepare()).toBe(preparing);
      await expect(preparing).rejects.toThrow("changed while being retained");
      expect(observed).toHaveBeenCalled();
      expect(owner.resolveAsset(old.assetPath)).not.toBeNull();
      expect(await fs.readdir(cache)).toEqual([old.manifest.generation]);
      await writeRetentionBuild(current.root, "current");
      await owner.prepare();
      expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
    });
  });

  it("skips generations larger than the hard cache budget before reading assets", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      const manifest = createRetentionManifest(
        ["a", "b"].map((label) => ({
          path: `assets/${label}.js`,
          sha256: "0".repeat(64),
          size: 50 * 1024 * 1024,
        })),
      );
      await fs.writeFile(
        path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
        JSON.stringify(manifest),
      );
      const owner = createControlUiAssetRetention(root);
      await owner.prepare();
      expect(owner.resolveAsset("assets/a.js")).toBeNull();
      expect(await fs.readdir(cache)).toEqual([]);
    });
  });

  it("prunes only generations and stale staging directories", async () => {
    await withRetentionFixture(async ({ seed, cache, root }) => {
      const current = await seed("current");
      const names = [".staging-1-aaaa", ".staging-2-bbbb", "unrelated", "e".repeat(64)] as const;
      for (const name of names) {
        await fs.mkdir(path.join(cache, name));
      }
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await fs.utimes(
        path.join(cache, names[0]),
        new Date(now - 3_600_000),
        new Date(now - 3_600_000),
      );
      await fs.utimes(
        path.join(cache, names[1]),
        new Date(now - 3_599_000),
        new Date(now - 3_599_000),
      );
      await fs.writeFile(path.join(root, "sentinel"), "outside");
      await fs.symlink(root, path.join(cache, "f".repeat(64)), "dir");
      await createControlUiAssetRetention(current.root).prepare();
      expect((await fs.readdir(cache)).toSorted()).toEqual(
        [current.manifest.generation, names[1], names[2], "f".repeat(64)].toSorted((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(await fs.readFile(path.join(root, "sentinel"), "utf8")).toBe("outside");
    });
  });
});
