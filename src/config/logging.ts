// Normalizes logging config, log paths, and file-size limits.
import fs from "node:fs";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../runtime.js";
import { displayPath } from "../utils.js";
import { createConfigIO } from "./io.js";

type LogConfigUpdatedOptions = {
  path?: string;
  backupPath?: string | false;
  suffix?: string;
};

/** Formats a config path for operator-facing log output. */
export function formatConfigPath(path: string = createConfigIO().configPath): string {
  return displayPath(path);
}

/** Builds the config-updated log message, including backup detail only when it exists. */
export function formatConfigUpdatedMessage(
  path: string,
  opts: LogConfigUpdatedOptions = {},
): string {
  const displayConfigPath = theme.muted(formatConfigPath(path));
  const suffix = opts.suffix ? ` ${opts.suffix}` : "";
  const backupPath = opts.backupPath === undefined ? `${path}.bak` : opts.backupPath;
  const lines = [`Updated config: ${displayConfigPath}${suffix}`];
  if (backupPath && fs.existsSync(backupPath)) {
    // Only mention backups that were actually written; callers can pass `false` for flows that
    // intentionally skip backup creation.
    lines.push(`  Backup: ${theme.muted(formatConfigPath(backupPath))}`);
  }
  return lines.join("\n");
}

/** Emits the standard config-updated message through the active runtime logger. */
export function logConfigUpdated(runtime: RuntimeEnv, opts: LogConfigUpdatedOptions = {}): void {
  runtime.log(formatConfigUpdatedMessage(opts.path ?? createConfigIO().configPath, opts));
}
