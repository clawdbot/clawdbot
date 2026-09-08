import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

describe("Control UI retained integrity", () => {
  it.each([
    "digest",
    "size",
    "missing",
    "manifest",
    "directory-name",
    "asset-symlink",
    "manifest-symlink",
    "directory-symlink",
  ] as const)("rejects cached %s corruption without disturbing outside bytes", async (fault) => {
    await withRetentionFixture(async ({ root, cache, seed }) => {
      const cached = await seed("cached");
      let cachedDirectory = cached.target;
      const asset = path.join(cached.target, cached.assetPath);
      const manifest = path.join(cached.target, "asset-manifest.json");
      const outside = path.join(root, "outside");
      await fs.cp(cached.target, outside, { recursive: true });
      switch (fault) {
        case "digest":
          await fs.writeFile(asset, Buffer.alloc(cached.manifest.assets[0]!.size, 120));
          break;
        case "size":
          await fs.writeFile(asset, "short");
          break;
        case "missing":
          await fs.rm(asset);
          break;
        case "manifest":
          await fs.writeFile(manifest, "{");
          break;
        case "directory-name":
          cachedDirectory = path.join(cache, "0".repeat(64));
          await fs.rename(cached.target, cachedDirectory);
          break;
        case "asset-symlink":
          await fs.rm(asset);
          await fs.symlink(path.join(outside, cached.assetPath), asset);
          break;
        case "manifest-symlink":
          await fs.rm(manifest);
          await fs.symlink(path.join(outside, "asset-manifest.json"), manifest);
          break;
        case "directory-symlink":
          await fs.rm(cached.target, { recursive: true });
          await fs.symlink(outside, cached.target, "dir");
          break;
      }
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const owner = createControlUiAssetRetention(current.root);
      let checkedAdmission = false;
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === path.join(current.root, "asset-manifest.json")) {
          checkedAdmission = true;
          expect(owner.resolveAsset(cached.assetPath)).toBeNull();
        }
        return readFile(...args);
      });
      await owner.prepare();
      expect(checkedAdmission).toBe(true);
      expect(owner.resolveAsset(cached.assetPath)).toBeNull();
      expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
      expect(await fs.readFile(path.join(outside, cached.assetPath), "utf8")).toContain("cached");
      expect((await fs.readdir(cache)).includes(path.basename(cachedDirectory))).toBe(
        fault === "directory-symlink",
      );
    });
  });

  it.each(["leaf-symlink", "parent-escape", "inode-swap"] as const)(
    "refuses source %s before publication",
    async (fault) => {
      await withRetentionFixture(async ({ root, cache }) => {
        const build = await writeRetentionBuild(path.join(root, "build"), "source", {
          size: fault === "inode-swap" ? 128 * 1024 : undefined,
        });
        const source = path.join(build.root, build.assetPath);
        const outside = path.join(root, "outside");
        await fs.cp(build.root, outside, { recursive: true });
        const outsideContents = await fs.readFile(path.join(outside, build.assetPath));
        if (fault === "leaf-symlink") {
          await fs.rm(source);
          await fs.symlink(path.join(outside, build.assetPath), source);
        } else if (fault === "parent-escape") {
          await fs.rm(path.join(build.root, "assets"), { recursive: true });
          await fs.symlink(path.join(outside, "assets"), path.join(build.root, "assets"), "dir");
        } else {
          const open = fs.open;
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] !== source) {
              return handle;
            }
            const read = handle.read.bind(handle);
            let replaced = false;
            vi.spyOn(handle, "read").mockImplementation((async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ) => {
              const result = await read(buffer, offset, length, position);
              if (!replaced && result.bytesRead > 0) {
                replaced = true;
                await fs.rename(source, `${source}.old`);
                await fs.copyFile(path.join(outside, build.assetPath), source);
              }
              return result;
            }) as typeof handle.read);
            return handle;
          });
        }
        const owner = createControlUiAssetRetention(build.root);
        await expect(owner.prepare()).rejects.toThrow(
          fault === "inode-swap" ? "changed while being retained" : "Unsafe Control UI asset",
        );
        expect(owner.resolveAsset(build.assetPath)).toBeNull();
        expect(await fs.readdir(cache)).toEqual([]);
        expect(await fs.readFile(path.join(outside, build.assetPath))).toEqual(outsideContents);
      });
    },
  );

  it("rejects a cached asset replaced after its handle opens", async () => {
    await withRetentionFixture(async ({ root, cache, seed }) => {
      const cached = await seed("cached", { size: 128 * 1024 });
      const asset = path.join(cached.target, cached.assetPath);
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const open = fs.open;
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] !== asset) {
          return handle;
        }
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const result = await read(buffer, offset, length, position);
          if (!replaced && result.bytesRead > 0) {
            replaced = true;
            await fs.rename(asset, `${asset}.old`);
            await fs.writeFile(asset, Buffer.alloc(cached.manifest.assets[0]!.size, 120));
          }
          return result;
        }) as typeof handle.read);
        return handle;
      });
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();
      expect(replaced).toBe(true);
      expect(owner.resolveAsset(cached.assetPath)).toBeNull();
      expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
      await expect(fs.access(cached.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(cache)).some((entry) => entry.startsWith(".staging-"))).toBe(false);
    });
  });
});
