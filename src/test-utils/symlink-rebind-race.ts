// Test helper for simulating symlink rebind races around filesystem reads.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

/** Repoints a symlink or junction to a new target for realpath race tests. */
export async function createRebindableDirectoryAlias(params: {
  aliasPath: string;
  targetPath: string;
}): Promise<void> {
  const aliasPath = path.resolve(params.aliasPath);
  const targetPath = path.resolve(params.targetPath);
  await fs.rm(aliasPath, { recursive: true, force: true });
  await fs.symlink(targetPath, aliasPath, process.platform === "win32" ? "junction" : undefined);
}

export async function withRealpathSymlinkRebindRace<T>(params: {
  shouldFlip: (realpathInput: string) => boolean;
  symlinkPath: string;
  symlinkTarget: string;
  timing?: "before-realpath" | "after-realpath";
  realpathApi?: "async" | "native-sync";
  run: () => Promise<T>;
}): Promise<T> {
  const realRealpath = fs.realpath.bind(fs);
  const realNativeRealpath = fsSync.realpathSync.native.bind(fsSync.realpathSync);
  let flipped = false;
  const rebindSync = () => {
    const aliasPath = path.resolve(params.symlinkPath);
    fsSync.rmSync(aliasPath, { recursive: true, force: true });
    fsSync.symlinkSync(
      path.resolve(params.symlinkTarget),
      aliasPath,
      process.platform === "win32" ? "junction" : undefined,
    );
  };
  // Select the owner's metadata API so unrelated earlier checks cannot consume the race.
  const shouldRebind = (filePath: string): boolean => {
    if (flipped || !params.shouldFlip(filePath)) {
      return false;
    }
    flipped = true;
    return true;
  };
  const realpathSpy =
    params.realpathApi === "native-sync"
      ? vi
          .spyOn(fsSync.realpathSync, "native")
          .mockImplementation((...args: Parameters<typeof fsSync.realpathSync.native>) => {
            if (shouldRebind(String(args[0]))) {
              if (params.timing !== "after-realpath") {
                rebindSync();
                return realNativeRealpath(...args);
              }
              const resolved = realNativeRealpath(...args);
              rebindSync();
              return resolved;
            }
            return realNativeRealpath(...args);
          })
      : vi
          .spyOn(fs, "realpath")
          .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
            if (shouldRebind(String(args[0]))) {
              if (params.timing !== "after-realpath") {
                await createRebindableDirectoryAlias({
                  aliasPath: params.symlinkPath,
                  targetPath: params.symlinkTarget,
                });
                return await realRealpath(...args);
              }
              const resolved = await realRealpath(...args);
              await createRebindableDirectoryAlias({
                aliasPath: params.symlinkPath,
                targetPath: params.symlinkTarget,
              });
              return resolved;
            }
            return await realRealpath(...args);
          });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
}
