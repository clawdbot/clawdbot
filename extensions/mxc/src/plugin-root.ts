import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isMxcPluginRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "openclaw.plugin.json")) &&
    fs.existsSync(path.join(dir, "package.json"))
  );
}

function resolveMxcPluginRoot(moduleUrl: string = import.meta.url): string {
  let cursor = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 6; i += 1) {
    if (isMxcPluginRoot(cursor)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  throw new Error(`[mxc] cannot locate plugin root from ${moduleUrl}`);
}

export function resolveMxcLauncherPath(moduleUrl: string = import.meta.url): string {
  const root = resolveMxcPluginRoot(moduleUrl);
  const sourceLauncher = path.join(root, "src", "mxc-spawn-launcher.mjs");
  const rootDistLauncher = path.join(root, "mxc-spawn-launcher.mjs");
  const packageDistLauncher = path.join(root, "dist", "mxc-spawn-launcher.mjs");
  if (fs.existsSync(sourceLauncher)) {
    return sourceLauncher;
  }
  if (fs.existsSync(rootDistLauncher)) {
    return rootDistLauncher;
  }
  if (fs.existsSync(packageDistLauncher)) {
    return packageDistLauncher;
  }
  throw new Error(
    `[mxc] launcher not found; searched ${sourceLauncher}, ${rootDistLauncher}, and ${packageDistLauncher}`,
  );
}
