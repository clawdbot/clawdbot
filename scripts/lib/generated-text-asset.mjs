import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes a generated text asset only when its contents changed.
 */
export async function writeGeneratedTextAsset(filePath, contents, params = {}) {
  const fsImpl = params.fs ?? fs;
  let currentContents = null;
  try {
    currentContents = await fsImpl.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (currentContents === contents) {
    return false;
  }

  await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
  await fsImpl.writeFile(filePath, contents, "utf8");
  return true;
}
