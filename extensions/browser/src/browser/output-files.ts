/**
 * Browser output file writer.
 *
 * Validates caller-provided output paths against a root before writing
 * screenshots, PDFs, downloads, or traces to disk.
 */
import path from "node:path";
import { writeExternalFileWithinRoot } from "../sdk-security-runtime.js";
import { ensureOutputDirectory } from "./output-directories.js";

/** Write a browser output file within a caller-selected output root. */
export async function writeExternalFileWithinOutputRoot(params: {
  rootDir?: string;
  path: string;
  write: (filePath: string) => Promise<void>;
}): Promise<string> {
  const outputPath = params.path.trim();
  if (!outputPath) {
    throw new Error("output path is required");
  }

  const rootDir = params.rootDir
    ? path.resolve(params.rootDir)
    : path.dirname(path.resolve(outputPath));
  await ensureOutputDirectory(rootDir);

  let writeCompleted = false;
  const result = await writeExternalFileWithinRoot({
    rootDir,
    path: outputPath,
    write: async (filePath) => {
      await params.write(filePath);
      writeCompleted = true;
    },
  }).catch((err: unknown) => {
    if (
      writeCompleted &&
      err instanceof Error &&
      (((err as NodeJS.ErrnoException).code ?? "") === "ENOENT" ||
        /file not found|no such file or directory/i.test(err.message))
    ) {
      throw new Error("output directory changed while writing file");
    }
    throw err;
  });
  return result.path;
}
