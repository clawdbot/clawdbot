import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledHooksDir(): string | undefined {
  const override = process.env.CLAWDBOT_BUNDLED_HOOKS_DIR?.trim();
  if (override) return override;

  // bun --compile: ship a sibling `hooks/bundled/` next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const sibling = path.join(execDir, "hooks", "bundled");
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    // ignore
  }

  // npm: resolve `<packageRoot>/dist/hooks/bundled` relative to this module (compiled hooks).
  // This path works when installed via npm: node_modules/moltbot/dist/hooks/bundled-dir.js
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const distBundled = path.join(moduleDir, "bundled");
    if (fs.existsSync(distBundled)) return distBundled;
  } catch {
    // ignore
  }

  // dev: resolve `<packageRoot>/src/hooks/bundled` relative to dist/hooks/bundled-dir.js
  // This path works in dev: dist/hooks/bundled-dir.js -> ../../src/hooks/bundled
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(moduleDir, "..", "..");
    const srcBundled = path.join(root, "src", "hooks", "bundled");
    if (fs.existsSync(srcBundled)) return srcBundled;
  } catch {
    // ignore
  }

  return undefined;
}
