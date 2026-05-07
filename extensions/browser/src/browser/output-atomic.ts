import fs from "node:fs/promises";
import { writeExternalFileWithinRoot } from "../sdk-security-runtime.js";

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  await fs.mkdir(params.rootDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir: params.rootDir,
    path: params.targetPath,
    write: params.writeTemp,
  });
}
