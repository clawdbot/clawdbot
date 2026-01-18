import path from "node:path";

import { resolveStateDir } from "clawdbot/plugin-sdk";

export type MSTeamsStorePathOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
  filename: string;
};

export function resolveMSTeamsStorePath(params: MSTeamsStorePathOptions): string {
  if (params.storePath) return params.storePath;
  if (params.stateDir) return path.join(params.stateDir, params.filename);

  const env = params.env ?? process.env;
  const stateDir = params.homedir ? resolveStateDir(env, params.homedir) : resolveStateDir(env);
  return path.join(stateDir, params.filename);
}
