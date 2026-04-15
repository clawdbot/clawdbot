import fs from "node:fs/promises";
import { resolveWritablePathWithinRoot } from "./path-output.js";
import type { BrowserResponse } from "./types.js";

export async function ensureOutputRootDir(rootDir: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
}

export async function resolveWritableOutputPathOrRespond(params: {
  res: BrowserResponse;
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
  ensureRootDir?: boolean;
}): Promise<string | null> {
  if (params.ensureRootDir) {
    await ensureOutputRootDir(params.rootDir);
  }
  const pathResult = await resolveWritablePathWithinRoot({
    rootDir: params.rootDir,
    requestedPath: params.requestedPath,
    scopeLabel: params.scopeLabel,
    defaultFileName: params.defaultFileName,
  });
  if (!pathResult.ok) {
    params.res.status(400).json({ error: pathResult.error });
    return null;
  }
  return pathResult.path;
}
