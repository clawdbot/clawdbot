import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import { resolveConfigPath } from "../../config/paths.js";

export async function createUpdateConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: resolveConfigPath(env),
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}
