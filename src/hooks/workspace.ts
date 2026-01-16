import fs from "node:fs";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import { shouldIncludeHook } from "./config.js";
import {
  parseFrontmatter,
  resolveClawdbotMetadata,
  resolveHookInvocationPolicy,
} from "./frontmatter.js";
import type {
  Hook,
  HookEligibilityContext,
  HookEntry,
  HookSnapshot,
  ParsedHookFrontmatter,
} from "./types.js";

const fsp = fs.promises;

function filterHookEntries(
  entries: HookEntry[],
  config?: ClawdbotConfig,
  eligibility?: HookEligibilityContext,
): HookEntry[] {
  return entries.filter((entry) => shouldIncludeHook({ entry, config, eligibility }));
}

/**
 * Scan a directory for hooks (subdirectories containing HOOK.md)
 */
function loadHooksFromDir(params: { dir: string; source: string }): Hook[] {
  const { dir, source } = params;

  // Check if directory exists
  if (!fs.existsSync(dir)) return [];

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return [];

  const hooks: Hook[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const hookDir = path.join(dir, entry.name);
    const hookMdPath = path.join(hookDir, "HOOK.md");

    // Skip if no HOOK.md file
    if (!fs.existsSync(hookMdPath)) continue;

    try {
      // Read HOOK.md to extract name and description
      const content = fs.readFileSync(hookMdPath, "utf-8");
      const frontmatter = parseFrontmatter(content);

      const name = frontmatter.name || entry.name;
      const description = frontmatter.description || "";

      // Locate handler file (handler.ts, handler.js, index.ts, index.js)
      const handlerCandidates = [
        "handler.ts",
        "handler.js",
        "index.ts",
        "index.js",
      ];

      let handlerPath: string | undefined;
      for (const candidate of handlerCandidates) {
        const candidatePath = path.join(hookDir, candidate);
        if (fs.existsSync(candidatePath)) {
          handlerPath = candidatePath;
          break;
        }
      }

      // Skip if no handler file found
      if (!handlerPath) {
        console.warn(`[hooks] Hook "${name}" has HOOK.md but no handler file in ${hookDir}`);
        continue;
      }

      hooks.push({
        name,
        description,
        source: source as Hook["source"],
        filePath: hookMdPath,
        baseDir: hookDir,
        handlerPath,
      });
    } catch (err) {
      console.warn(`[hooks] Failed to load hook from ${hookDir}:`, err);
      continue;
    }
  }

  return hooks;
}

function loadHookEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): HookEntry[] {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const workspaceHooksDir = path.join(workspaceDir, "hooks");
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  const extraDirsRaw = opts?.config?.hooks?.internal?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);

  const bundledHooks = bundledHooksDir
    ? loadHooksFromDir({
        dir: bundledHooksDir,
        source: "clawdbot-bundled",
      })
    : [];
  const extraHooks = extraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadHooksFromDir({
      dir: resolved,
      source: "clawdbot-workspace", // Extra dirs treated as workspace
    });
  });
  const managedHooks = loadHooksFromDir({
    dir: managedHooksDir,
    source: "clawdbot-managed",
  });
  const workspaceHooks = loadHooksFromDir({
    dir: workspaceHooksDir,
    source: "clawdbot-workspace",
  });

  const merged = new Map<string, Hook>();
  // Precedence: extra < bundled < managed < workspace (workspace wins)
  for (const hook of extraHooks) merged.set(hook.name, hook);
  for (const hook of bundledHooks) merged.set(hook.name, hook);
  for (const hook of managedHooks) merged.set(hook.name, hook);
  for (const hook of workspaceHooks) merged.set(hook.name, hook);

  const hookEntries: HookEntry[] = Array.from(merged.values()).map((hook) => {
    let frontmatter: ParsedHookFrontmatter = {};
    try {
      const raw = fs.readFileSync(hook.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed hooks
    }
    return {
      hook,
      frontmatter,
      clawdbot: resolveClawdbotMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
  });
  return hookEntries;
}

export function buildWorkspaceHookSnapshot(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
    entries?: HookEntry[];
    eligibility?: HookEligibilityContext;
    snapshotVersion?: number;
  },
): HookSnapshot {
  const hookEntries = opts?.entries ?? loadHookEntries(workspaceDir, opts);
  const eligible = filterHookEntries(hookEntries, opts?.config, opts?.eligibility);

  return {
    hooks: eligible.map((entry) => ({
      name: entry.hook.name,
      events: entry.clawdbot?.events ?? [],
    })),
    resolvedHooks: eligible.map((entry) => entry.hook),
    version: opts?.snapshotVersion,
  };
}

export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): HookEntry[] {
  return loadHookEntries(workspaceDir, opts);
}
