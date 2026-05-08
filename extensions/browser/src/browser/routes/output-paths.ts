import { ensureOutputDirectory } from "../output-directories.js";
import { pathScope } from "./path-output.js";
import type { BrowserResponse } from "./types.js";

export async function ensureOutputRootDir(rootDir: string): Promise<void> {
  await ensureOutputDirectory(rootDir);
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
  const pathResult = await pathScope(params.rootDir, { label: params.scopeLabel }).writable(
    params.requestedPath,
    { defaultName: params.defaultFileName },
  );
  if (!pathResult.ok) {
    params.res.status(400).json({ error: pathResult.error });
    return null;
  }
  return pathResult.path;
}
