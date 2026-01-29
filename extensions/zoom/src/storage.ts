/**
 * Storage path resolution for Zoom plugin state files.
 */
import path from "node:path";

import { getZoomRuntime } from "./runtime.js";

export type ZoomStorePathOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
  filename: string;
};

export function resolveZoomStorePath(params: ZoomStorePathOptions): string {
  if (params.storePath) return params.storePath;
  if (params.stateDir) return path.join(params.stateDir, params.filename);

  const env = params.env ?? process.env;
  const stateDir = params.homedir
    ? getZoomRuntime().state.resolveStateDir(env, params.homedir)
    : getZoomRuntime().state.resolveStateDir(env);
  return path.join(stateDir, params.filename);
}
