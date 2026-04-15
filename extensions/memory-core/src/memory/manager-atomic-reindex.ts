import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

export async function moveMemoryIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    const source = `${sourceBase}${suffix}`;
    const target = `${targetBase}${suffix}`;
    try {
      await fs.rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

export async function removeMemoryIndexFiles(basePath: string): Promise<void> {
  const suffixes = ["", "-wal", "-shm"];
  await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
}

export async function swapMemoryIndexFiles(targetPath: string, tempPath: string): Promise<void> {
  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  await moveMemoryIndexFiles(targetPath, backupPath);
  try {
    await moveMemoryIndexFiles(tempPath, targetPath);
  } catch (err) {
    await moveMemoryIndexFiles(backupPath, targetPath);
    throw err;
  }
  await removeMemoryIndexFiles(backupPath);
}

export async function runMemoryAtomicReindex<T>(params: {
  targetPath: string;
  tempPath: string;
  build: () => Promise<T>;
}): Promise<T> {
  try {
    const result = await params.build();
    await swapMemoryIndexFiles(params.targetPath, params.tempPath);
    return result;
  } catch (err) {
    await removeMemoryIndexFiles(params.tempPath);
    throw err;
  }
}
