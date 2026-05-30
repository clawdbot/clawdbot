import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";

function looksLikeSkillsDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        return true;
      }
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(fullPath, "SKILL.md"))) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export type BundledSkillsResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

export function resolveBundledSkillsDir(
  opts: BundledSkillsResolveOptions = {},
): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `skills/` next to the executable.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = path.dirname(execPath);
    const sibling = path.join(execDir, "skills");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: resolve `<packageRoot>/skills` relative to this module.
  try {
    const moduleUrl = opts.moduleUrl ?? import.meta.url;
    const moduleDir = path.dirname(fileURLToPath(moduleUrl));
    const argv1 = opts.argv1 ?? process.argv[1];
    const cwd = opts.cwd ?? process.cwd();
    const packageRoot = resolveOpenClawPackageRootSync({
      argv1,
      moduleUrl,
      cwd,
    });
    if (packageRoot) {
      const candidate = path.join(packageRoot, "skills");
      if (looksLikeSkillsDir(candidate)) {
        return candidate;
      }
    }
    let current = moduleDir;
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(current, "skills");
      if (looksLikeSkillsDir(candidate)) {
        return candidate;
      }
      const next = path.dirname(current);
      if (next === current) {
        break;
      }
      current = next;
    }
  } catch {
    // ignore
  }

  return undefined;
}
