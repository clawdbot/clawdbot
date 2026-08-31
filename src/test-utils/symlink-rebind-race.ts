// Test helper for simulating symlink rebind races around filesystem reads.
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
  run: () => Promise<T>;
}): Promise<T> {
  const realRealpath = fs.realpath.bind(fs);
  let flipped = false;
  // Flip exactly once around realpath so tests can model TOCTOU behavior deterministically.
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = String(args[0]);
      if (!flipped && params.shouldFlip(filePath)) {
        flipped = true;
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
