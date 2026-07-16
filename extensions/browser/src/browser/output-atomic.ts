import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileFromPathWithinRoot } from "../infra/fs-safe.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

function buildSiblingTempPath(targetPath: string): string {
  const id = crypto.randomUUID();
  const safeTail = sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
  return path.join(path.dirname(targetPath), `.openclaw-output-${id}-${safeTail}.part`);
}

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  const rootDir = await fs
    .realpath(path.resolve(params.rootDir))
    .catch(() => path.resolve(params.rootDir));
  const requestedTargetPath = path.resolve(params.targetPath);
  const targetPath = await fs
    .realpath(path.dirname(requestedTargetPath))
    .then((realDir) => path.join(realDir, path.basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);
  const relativeTargetPath = path.relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Target path is outside the allowed root");
  }
  const tempPath = buildSiblingTempPath(targetPath);
  let renameSucceeded = false;
  try {
    await params.writeTemp(tempPath);
    await writeFileFromPathWithinRoot({
      rootDir,
      relativePath: relativeTargetPath,
      sourcePath: tempPath,
      mkdir: false,
    });
    renameSucceeded = true;
  } finally {
    if (!renameSucceeded) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
