import fs from "node:fs/promises";
import path from "node:path";

type GeneratedTextAssetFs = Pick<typeof fs, "mkdir" | "readFile" | "writeFile">;

/**
 * Writes a generated text asset only when its contents changed.
 */
export async function writeGeneratedTextAsset(
  filePath: string,
  contents: string,
  params: { fs?: GeneratedTextAssetFs } = {},
) {
  const fsImpl = params.fs ?? fs;
  let currentContents = null;
  try {
    currentContents = await fsImpl.readFile(filePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
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
