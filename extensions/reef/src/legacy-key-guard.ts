import fs from "node:fs/promises";
import os from "node:os";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveLegacyReefStateDir } from "./doctor-state-paths.js";

export const REEF_LEGACY_KEYS_PENDING_CODE = "REEF_LEGACY_KEYS_PENDING";

export async function assertLegacyReefKeysMigrated(
  configuredStateDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): Promise<void> {
  const legacyStateDir = resolveLegacyReefStateDir({
    config: configuredStateDir ? { channels: { reef: { stateDir: configuredStateDir } } } : {},
    env,
    stateDir: resolveStateDir(env, () => homeDir),
    homeDir,
  });
  const filePath = `${legacyStateDir}/keys.json`;
  try {
    await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw Object.assign(
    new Error(
      "Legacy Reef identity keys must be imported before registration. Run `openclaw doctor --fix`, then retry.",
    ),
    { code: REEF_LEGACY_KEYS_PENDING_CODE },
  );
}
