import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import {
  parseFrontmatter,
  resolveHookInvocationPolicy,
  resolveOpenClawMetadata,
} from "./frontmatter.js";
import { resolvePluginHookDirs } from "./plugin-hooks.js";
import { resolveHookEntries } from "./policy.js";
import type { Hook, HookEntry, HookSource, ParsedHookFrontmatter } from "./types.js";

type HookPackageManifest = {
  name?: string;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;
const log = createSubsystemLogger("hooks/workspace");

type LoadedHook = {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
};

function readHookPackageManifest(dir: string): HookPackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const raw = readBoundaryFileUtf8({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "hook package directory",
  });
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as HookPackageManifest;
  } catch {
    return null;
  }
}

function resolvePackageHooks(manifest: HookPackageManifest): string[] {
  const raw = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function resolveContainedDir(baseDir: string, targetDir: string): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, targetDir);
  if (
    !isPathInsideWithRealpath(base, resolved, {
      requireRealpath: true,
    })
  ) {
    return null;
  }
  return resolved;
}

function loadHookFromDir(params: {
  hookDir: string;
  source: HookSource;
  pluginId?: string;
  nameHint?: string;
}): LoadedHook | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");
  const content = readBoundaryFileUtf8({
    absolutePath: hookMdPath,
    rootPath: params.hookDir,
    boundaryLabel: "hook directory",
  });
  if (content === null) {
    return null;
  }
  try {
    const frontmatter = parseFrontmatter(content);

    const name = frontmatter.name || params.nameHint || path.basename(params.hookDir);
    const description = frontmatter.description || "";

    const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
    let handlerPath: string | undefined;
    for (const candidate of handlerCandidates) {
      const candidatePath = path.join(params.hookDir, candidate);
      const safeCandidatePath = resolveBoundaryFilePath({
        absolutePath: candidatePath,
        rootPath: params.hookDir,
        boundaryLabel: "hook directory",
      });
      if (safeCandidatePath) {
        handlerPath = safeCandidatePath;
        break;
      }
    }

    if (!handlerPath) {
      log.warn(`Hook "${name}" has HOOK.md but no handler file in ${params.hookDir}`);
      return null;
    }

    let baseDir = params.hookDir;
    try {
      baseDir = fs.realpathSync.native(params.hookDir);
    } catch {
      // keep the discovered path when realpath is unavailable
    }

    return {
      hook: {
        name,
        description,
        source: params.source,
        pluginId: params.pluginId,
        filePath: hookMdPath,
        baseDir,
        handlerPath,
      },
      frontmatter,
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`Failed to load hook from ${params.hookDir}: ${message}`);
    return null;
  }
}

/**
 * Scan a directory for hooks (subdirectories containing HOOK.md)
 */
function loadHooksFromDir(params: {
  dir: string;
  source: HookSource;
  pluginId?: string;
}): LoadedHook[] {
  const { dir, source, pluginId } = params;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    return [];
  }

  const hooks: LoadedHook[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const hookDir = path.join(dir, entry.name);
    const manifest = readHookPackageManifest(hookDir);
    const packageHooks = manifest ? resolvePackageHooks(manifest) : [];

    if (packageHooks.length > 0) {
      for (const hookPath of packageHooks) {
        const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
        if (!resolvedHookDir) {
          log.warn(
            `Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`,
          );
          continue;
        }
        const hook = loadHookFromDir({
          hookDir: resolvedHookDir,
          source,
          pluginId,
          nameHint: path.basename(resolvedHookDir),
        });
        if (hook) {
          hooks.push(hook);
        }
      }
      continue;
    }

    const hook = loadHookFromDir({
      hookDir,
      source,
      pluginId,
      nameHint: entry.name,
    });
    if (hook) {
      hooks.push(hook);
    }
  }

  return hooks;
}

export function loadHookEntriesFromDir(params: {
  dir: string;
  source: HookSource;
  pluginId?: string;
}): HookEntry[] {
  const hooks = loadHooksFromDir({
    dir: params.dir,
    source: params.source,
    pluginId: params.pluginId,
  });
  return hooks.map(({ hook, frontmatter }) => {
    const entry: HookEntry = {
      hook: {
        ...hook,
        source: params.source,
        pluginId: params.pluginId,
      },
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
    return entry;
  });
}

function discoverWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
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
  const pluginHookDirs = resolvePluginHookDirs({
    workspaceDir,
    config: opts?.config,
  });

  const bundledHooks = bundledHooksDir
    ? loadHookEntriesFromDir({
        dir: bundledHooksDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraHooks = extraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadHookEntriesFromDir({
      dir: resolved,
      source: "openclaw-managed",
    });
  });
  const pluginHooks = pluginHookDirs.flatMap(({ dir, pluginId }) =>
    loadHookEntriesFromDir({
      dir,
      source: "openclaw-plugin",
      pluginId,
    }),
  );
  const managedHooks = loadHookEntriesFromDir({
    dir: managedHooksDir,
    source: "openclaw-managed",
  });
  const workspaceHooks = loadHookEntriesFromDir({
    dir: workspaceHooksDir,
    source: "openclaw-workspace",
  });

  return [...extraHooks, ...bundledHooks, ...pluginHooks, ...managedHooks, ...workspaceHooks];
}

export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
    entries?: HookEntry[];
  },
): HookEntry[] {
  return resolveHookEntries(opts?.entries ?? discoverWorkspaceHookEntries(workspaceDir, opts), {
    onCollisionIgnored: ({ name, kept, ignored }) => {
      log.warn(
        `Ignoring ${ignored.hook.source} hook "${name}" because it cannot override ${kept.hook.source} hook code`,
      );
    },
  });
}

function readBoundaryFileUtf8(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
}): string | null {
  return withOpenedBoundaryFileSync(params, (opened) => {
    try {
      return fs.readFileSync(opened.fd, "utf-8");
    } catch {
      return null;
    }
  });
}

function withOpenedBoundaryFileSync<T>(
  params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
  },
  read: (opened: { fd: number; path: string }) => T,
): T | null {
  const opened = openBoundaryFileSync({
    absolutePath: params.absolutePath,
    rootPath: params.rootPath,
    boundaryLabel: params.boundaryLabel,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return read({ fd: opened.fd, path: opened.path });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveBoundaryFilePath(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
}): string | null {
  return withOpenedBoundaryFileSync(params, (opened) => opened.path);
}
