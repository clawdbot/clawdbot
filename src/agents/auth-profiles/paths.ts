import fs from "node:fs";
import { saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileSecretsStore } from "./types.js";
export {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
  resolveOAuthRefreshLockPath,
} from "./path-resolve.js";

export function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) {
    return;
  }
  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}
