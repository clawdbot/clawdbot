/**
 * Atomic output write helper.
 *
 * Ensures browser-generated files are written through a sibling temp path under
 * an allowed output root before becoming visible at the target path.
 */
import { writeExternalFileWithinRoot } from "../sdk-security-runtime.js";
import { ensureOutputDirectory } from "./output-directories.js";

/** Write a file inside an output root via a caller-provided temp writer. */
export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  await ensureOutputDirectory(params.rootDir);
  await writeExternalFileWithinRoot({
    rootDir: params.rootDir,
    path: params.targetPath,
    write: params.writeTemp,
  });
}
