import fs from "node:fs";
import type { RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { displayPath } from "../utils.js";
import { createConfigIO } from "./io.js";

type LogConfigUpdatedOptions = {
  path?: string;
  backupPath?: string | false;
  suffix?: string;
};

export function formatConfigPath(path: string = createConfigIO().configPath): string {
  return displayPath(path);
}

export function formatConfigUpdatedMessage(
  path: string,
  opts: LogConfigUpdatedOptions = {},
): string {
  const displayConfigPath = theme.muted(formatConfigPath(path));
  const suffix = opts.suffix ? ` ${opts.suffix}` : "";
  const backupPath = opts.backupPath === undefined ? `${path}.bak` : opts.backupPath;
  const lines = [`Updated config: ${displayConfigPath}${suffix}`];
  if (backupPath && fs.existsSync(backupPath)) {
    lines.push(`  Backup: ${theme.muted(formatConfigPath(backupPath))}`);
  }
  return lines.join("\n");
}

export function logConfigUpdated(runtime: RuntimeEnv, opts: LogConfigUpdatedOptions = {}): void {
  runtime.log(formatConfigUpdatedMessage(opts.path ?? createConfigIO().configPath, opts));
}
