import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { resolveConfigPath } from "../../config/paths.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";

export type UpdateConfigSnapshot = {
  path: string;
  raw: string | null;
  hash: string;
  doctorOwned?: boolean;
};

export async function readUpdateConfigSnapshot(path: string): Promise<UpdateConfigSnapshot> {
  const raw = await fs.readFile(path, "utf8").catch((error: unknown) => {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  return { path, raw, hash: hashConfigRaw(raw) };
}

export async function createUpdateConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: resolveConfigPath(env),
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}
