/** Native writer facts are evidence, never serialized lifecycle authority. */
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hasErrnoCode } from "../infra/errno.js";

const fileState = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int().nonnegative(),
  dev: z.number().nonnegative(),
  ino: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  ctimeMs: z.number().finite(),
});
export const GatewayServiceStagedFilesSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        sourcePath: z.string().max(4096).refine(path.isAbsolute),
        before: fileState.nullable(),
        after: fileState,
      }),
    )
    .min(1)
    .max(16),
});
export type GatewayServiceStagedFiles = z.infer<typeof GatewayServiceStagedFilesSchema>;
type GatewayServiceFileState = z.infer<typeof fileState>;

/** Read one stable regular file; publication owners compare it to retained write facts. */
export async function readServiceFileState(file: string): Promise<GatewayServiceFileState | null> {
  const before = await fs.lstat(file).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!before) {
    return null;
  }
  if (!before.isFile()) {
    throw new Error("Managed service artifact is not a regular file.");
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const keys = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"] as const;
    if (!opened.isFile() || keys.some((key) => before[key] !== opened[key])) {
      throw new Error("Managed service artifact changed before inspection.");
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (keys.some((key) => before[key] !== after[key] || after[key] !== current[key])) {
      throw new Error("Managed service artifact changed during inspection.");
    }
    return {
      sha256: createHash("sha256").update(contents).digest("hex"),
      mode: after.mode & 0o777,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}
