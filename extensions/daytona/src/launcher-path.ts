// Locates the exec launcher shipped with this plugin across source and dist layouts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_FILE_NAME = "daytona-exec-launcher.mjs";

function isDaytonaPluginRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "openclaw.plugin.json")) &&
    fs.existsSync(path.join(dir, "package.json"))
  );
}

function resolveDaytonaPluginRoot(moduleUrl: string): string {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i += 1) {
    if (isDaytonaPluginRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  throw new Error(`[daytona] cannot locate plugin root from ${moduleUrl}`);
}

export function resolveDaytonaLauncherPath(moduleUrl: string = import.meta.url): string {
  const root = resolveDaytonaPluginRoot(moduleUrl);
  const candidates = [
    path.join(root, "src", LAUNCHER_FILE_NAME),
    path.join(root, LAUNCHER_FILE_NAME),
    path.join(root, "dist", LAUNCHER_FILE_NAME),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`[daytona] launcher not found; searched ${candidates.join(", ")}`);
}
