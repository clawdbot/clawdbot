import fs from "node:fs/promises";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

export async function archiveBindingSidecar(sourcePath: string): Promise<void> {
  const archivePath = `${sourcePath}.migrated`;
  if (!(await pathExists(archivePath))) {
    await fs.rename(sourcePath, archivePath);
    return;
  }
  const [sourceBytes, archiveBytes] = await Promise.all([
    fs.readFile(sourcePath),
    fs.readFile(archivePath),
  ]);
  if (sourceBytes.equals(archiveBytes)) {
    await fs.rm(sourcePath, { force: true });
    return;
  }
  await fs.rename(sourcePath, await firstFreeArchivePath(sourcePath));
}
