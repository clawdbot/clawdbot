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

  // npm/dev: resolve `<packageRoot>/hooks/bundled` relative to this module.
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(moduleDir, "..", "..");
    const candidate = path.join(root, "hooks", "bundled");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }

  return undefined;
}
