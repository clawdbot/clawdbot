import type { RuntimeEnv } from "../runtime.js";
import { displayPath } from "../utils.js";
import { CONFIG_PATH } from "./paths.js";

type LogConfigUpdatedOptions = {
  path?: string;
  suffix?: string;
};

export function formatConfigPath(path: string = CONFIG_PATH): string {
  return displayPath(path);
}

export function logConfigUpdated(runtime: RuntimeEnv, opts: LogConfigUpdatedOptions = {}): void {
  const path = formatConfigPath(opts.path ?? CONFIG_PATH);
  const suffix = opts.suffix ? ` ${opts.suffix}` : "";
  runtime.log(`Updated ${path}${suffix}`);
}
