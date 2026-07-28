// Matrix plugin module implements sqlite state behavior.
import os from "node:os";
import { getMatrixRuntime } from "../runtime.js";

type MatrixSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateRootDir?: string;
};

function resolveStateDirOverride(
  options: MatrixSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.stateDir) {
    return options.stateDir;
  }
  if (options.stateRootDir) {
    return options.stateRootDir;
  }
  return getMatrixRuntime().state.resolveStateDir(options.env ?? process.env, os.homedir);
}

export function resolveMatrixSqliteStateKey(options: MatrixSqliteStateOptions | undefined): string {
  return resolveStateDirOverride(options) ?? "";
}

export function resolveMatrixSqliteStateEnv(
  options: MatrixSqliteStateOptions | undefined,
): NodeJS.ProcessEnv | undefined {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return options?.env;
  }
  return {
    ...(options?.env ?? process.env),
    OPENCLAW_STATE_DIR: stateDir,
  };
}
