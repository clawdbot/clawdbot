import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolvePluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "plugin-state");
}

export function resolvePluginStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePluginStateDir(env), "state.sqlite");
}
