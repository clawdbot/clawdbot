import { pathExists } from "../infra/fs-safe.js";

export async function fileExists(filePath?: string | null): Promise<boolean> {
  return filePath ? await pathExists(filePath) : false;
}
