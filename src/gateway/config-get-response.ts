import fs from "node:fs";
import { createConfigIO, readConfigFileSnapshot } from "../config/config.js";
import { redactConfigSnapshot } from "../config/redact-snapshot.js";
import { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";

type ConfigGetResponse = ReturnType<typeof createConfigGetResponse>;
const CONFIG_GET_REVALIDATE_MS = 5_000;
let configGetResponseCache:
  | { expiresAt: number; key: string; promise: Promise<ConfigGetResponse> }
  | undefined;

async function configGetResponseCacheKey(configPath: string): Promise<string | undefined> {
  let stamp: [mtimeMs: number | null, size: number];
  try {
    const stat = await fs.promises.stat(configPath);
    stamp = [stat.mtimeMs, stat.size];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return undefined;
    }
    stamp = [null, 0];
  }
  return JSON.stringify([
    configPath,
    ...stamp,
    getRuntimeConfigAppliedHash(),
    getActivePluginRegistryVersion(),
  ]);
}

function createConfigGetResponse(
  snapshot: ConfigFileSnapshot,
  uiHints: Parameters<typeof redactConfigSnapshot>[1],
) {
  return {
    ...redactConfigSnapshot(snapshot, uiHints),
    configRevisionHash: hashRuntimeConfigValue(snapshot.sourceConfig),
    appliedConfigHash: getRuntimeConfigAppliedHash(),
  };
}

/** Reads and projects config.get once per on-disk, runtime, and plugin-schema revision. */
export async function readConfigGetResponse(params: {
  loadUiHints: () => Parameters<typeof redactConfigSnapshot>[1];
}): Promise<ConfigGetResponse> {
  const path = createConfigIO().configPath;
  const key = await configGetResponseCacheKey(path);
  if (!key) {
    return createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints());
  }
  if (configGetResponseCache?.key === key && configGetResponseCache.expiresAt > Date.now()) {
    return await configGetResponseCache.promise;
  }

  const promise = (async () =>
    createConfigGetResponse(await readConfigFileSnapshot(), params.loadUiHints()))();
  configGetResponseCache = { expiresAt: Date.now() + CONFIG_GET_REVALIDATE_MS, key, promise };
  try {
    return await promise;
  } catch (error) {
    if (configGetResponseCache?.promise === promise) {
      configGetResponseCache = undefined;
    }
    throw error;
  }
}

/** Invalidates cached config.get work after the canonical config write commits. */
export function invalidateConfigGetResponseCache(): void {
  configGetResponseCache = undefined;
}
