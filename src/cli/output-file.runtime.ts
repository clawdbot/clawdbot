import fs from "node:fs/promises";
import path from "node:path";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";

const DEFAULT_CLI_OUTPUT_TEMP_PREFIX = ".openclaw-media-output";

async function resolveExistingOutputMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Publish a CLI-owned file only after its sibling temp write completes. */
export async function publishOutputFileAtomically<T>(params: {
  filePath: string;
  writeTemp: (tempPath: string) => Promise<T>;
  tempPrefix?: string;
  durable?: boolean;
}): Promise<T> {
  const dir = path.dirname(params.filePath);
  await fs.mkdir(dir, { recursive: true });
  const mode = await resolveExistingOutputMode(params.filePath);
  // Keep prior destination bytes and the existing directory mode untouched until completion.
  const { result } = await writeSiblingTempFile({
    dir,
    chmodDir: false,
    tempPrefix: params.tempPrefix ?? DEFAULT_CLI_OUTPUT_TEMP_PREFIX,
    ...(mode === undefined ? {} : { mode }),
    ...(params.durable ? { syncTempFile: true, syncParentDir: true } : {}),
    writeTemp: params.writeTemp,
    resolveFinalPath: () => params.filePath,
  });
  return result;
}
