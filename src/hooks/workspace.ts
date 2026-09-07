// Hook workspace helpers resolve hook roots and workspace-local hook files.
import fs from "node:fs";
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { parseFrontmatterBlockResult } from "../../packages/markdown-core/src/frontmatter.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import { resolveHookInvocationPolicy, resolveHookManifestMetadata } from "./frontmatter.js";
import { resolvePluginHookDirs } from "./plugin-hooks.js";
import { resolveHookEntries } from "./policy.js";
import type { Hook, HookEntry, HookPolicyEntry, HookSource } from "./types.js";

// Hook descriptors are small metadata. Bounding the pinned descriptor read also
// covers files that grow after the boundary open validates their identity.
const HOOK_METADATA_MAX_BYTES = 1024 * 1024;

type HookPackageManifest = {
  name?: string;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;
const log = createSubsystemLogger("hooks/workspace");

type DiscoveredHookEntry = Omit<HookEntry, "hook"> & {
  hook: Omit<Hook, "handlerPath"> & { handlerPath?: string };
  invalidMetadata?: boolean;
};

type HookDiscoveryRoot = {
  dir: string;
  source: HookSource;
  pluginId?: string;
  rootDir?: string;
  includeRoot?: boolean;
};

export type HookSourceFact = HookPolicyEntry & { rootId: string; filePath: string };
type HookCandidate = HookSourceFact & { entry?: DiscoveredHookEntry };
type HookDiscoveryOptions = {
  config?: OpenClawConfig;
  managedHooksDir?: string;
  bundledHooksDir?: string;
};

function readHookPackageManifest(dir: string): HookPackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const raw = readRootFileUtf8({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "hook package directory",
    maxBytes: HOOK_METADATA_MAX_BYTES,
  });
  if (raw === null) {
    return null;
  }
  return (safeParseJson(raw) as HookPackageManifest | undefined) ?? null;
}

function resolvePackageHooks(manifest: HookPackageManifest): string[] {
  return normalizeTrimmedStringList(manifest[MANIFEST_KEY]?.hooks);
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
}): DiscoveredHookEntry | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");
  const content = readRootFileUtf8({
    absolutePath: hookMdPath,
    rootPath: params.hookDir,
    boundaryLabel: "hook directory",
    maxBytes: HOOK_METADATA_MAX_BYTES,
  });
  if (content === null) {
    return null;
  }
  try {
    const { frontmatter, issues } = parseFrontmatterBlockResult(content);

    const name = frontmatter.name || path.basename(params.hookDir);
    const description = frontmatter.description || "";

    const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
    let handlerPath: string | undefined;
    for (const candidate of handlerCandidates) {
      const candidatePath = path.join(params.hookDir, candidate);
      const safeCandidatePath = resolveRootFilePath({
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
      log.warn(`Hook "${name}" has HOOK.md but no readable handler in ${params.hookDir}`);
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
      invalidMetadata: issues.length > 0,
      metadata: resolveHookManifestMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`Failed to load hook from ${params.hookDir}: ${message}`);
    return null;
  }
}

function loadHooksFromCandidate(params: {
  hookDir: string;
  source: HookSource;
  pluginId?: string;
}): DiscoveredHookEntry[] | null {
  const { hookDir, source, pluginId } = params;
  const manifest = readHookPackageManifest(hookDir);
  const packageHooks = manifest ? resolvePackageHooks(manifest) : [];
  if (packageHooks.length === 0) {
    if (!fs.existsSync(path.join(hookDir, "HOOK.md"))) {
      return null;
    }
    const hook = loadHookFromDir(params);
    return hook ? [hook] : [];
  }

  const hooks: DiscoveredHookEntry[] = [];
  for (const hookPath of packageHooks) {
    const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
    if (!resolvedHookDir) {
      log.warn(
        `Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`,
      );
      continue;
    }
    // Pack entries are hook leaves, never another pack or a collection to scan.
    const hook = loadHookFromDir({
      hookDir: resolvedHookDir,
      source,
      pluginId,
    });
    if (hook) {
      hooks.push(hook);
    }
  }

  return hooks;
}

function loadHookEntriesFromDir(params: HookDiscoveryRoot): DiscoveredHookEntry[] {
  const { dir, source, pluginId } = params;
  // Plugin policy selects roots even when their files disappear. Boundary checks
  // belong to discovery, so atomic reload can retain the selected source fact.
  if (params.rootDir && !isPathInsideWithRealpath(params.rootDir, dir, { requireRealpath: true })) {
    log.warn(`Plugin hook path is missing or escapes plugin root (${pluginId}): ${dir}`);
    return [];
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  const rootHooks = params.includeRoot
    ? loadHooksFromCandidate({ hookDir: dir, source, pluginId })
    : null;
  // null means a collection. A recognized root with rejected hooks stays empty;
  // falling back to children would execute code its manifest did not select.
  return (
    rootHooks ??
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) {
        return [];
      }
      return (
        loadHooksFromCandidate({ hookDir: path.join(dir, entry.name), source, pluginId }) ?? []
      );
    })
  );
}

function resolveHookDiscoveryRoots(
  workspaceDir: string,
  opts?: HookDiscoveryOptions,
): HookDiscoveryRoot[] {
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  return [
    ...normalizeTrimmedStringList(opts?.config?.hooks?.internal?.load?.extraDirs).map((dir) => ({
      dir: resolveUserPath(dir),
      source: "openclaw-managed" as const,
      includeRoot: true,
    })),
    ...(bundledHooksDir ? [{ dir: bundledHooksDir, source: "openclaw-bundled" as const }] : []),
    ...resolvePluginHookDirs({ workspaceDir, config: opts?.config }).map(
      ({ dir, pluginId, rootDir }) => ({
        dir,
        pluginId,
        rootDir,
        source: "openclaw-plugin" as const,
      }),
    ),
    { dir: opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks"), source: "openclaw-managed" },
    { dir: path.join(workspaceDir, "hooks"), source: "openclaw-workspace" },
  ];
}

/** Prepare source-policy facts separately from executable, freshly discovered handlers. */
export function prepareWorkspaceHookEntries(
  workspaceDir: string,
  opts?: HookDiscoveryOptions & {
    previousSources?: HookSourceFact[];
    requireValidHook?: (entry: HookPolicyEntry) => boolean;
  },
): { entries: HookEntry[]; sources: HookSourceFact[] } {
  const candidates = resolveHookDiscoveryRoots(workspaceDir, opts).flatMap((root) => {
    const rootId = JSON.stringify([
      root.source,
      path.resolve(root.dir),
      root.pluginId,
      Boolean(root.includeRoot),
      root.rootDir,
    ]);
    const entries: HookCandidate[] = loadHookEntriesFromDir(root).map((entry) => ({
      rootId,
      filePath: entry.hook.filePath,
      hook: { name: entry.hook.name, source: entry.hook.source },
      metadata: entry.metadata,
      entry,
    }));
    for (const previous of opts?.previousSources ?? []) {
      if (previous.rootId !== rootId) {
        continue;
      }
      const index = entries.findIndex((candidate) => candidate.filePath === previous.filePath);
      const entry = entries[index]?.entry;
      if (entry && !entry.invalidMetadata && entry.metadata?.events.length) {
        continue;
      }
      if (index >= 0) {
        entries.splice(index, 1);
      }
      // A lost winner still shadows lower code. Its metadata can select an error
      // or an intentional non-outcome, but can never supply executable handlers.
      entries.push({ ...previous, entry });
    }
    return entries;
  });
  const resolved = resolveHookEntries(
    opts?.requireValidHook ? candidates : candidates.filter(({ entry }) => entry?.hook.handlerPath),
    {
      onCollisionIgnored: ({ name, kept, ignored }) => {
        log.warn(
          `Ignoring ${ignored.hook.source} hook "${name}" because it cannot override ${kept.hook.source} hook code`,
        );
      },
    },
  );
  const entries = resolved
    .flatMap((candidate) => {
      const { entry } = candidate;
      if (opts?.requireValidHook) {
        if (!opts.requireValidHook(candidate)) {
          return [];
        }
        if (!entry || entry.invalidMetadata || !entry.metadata?.events.length) {
          throw new Error(
            `Hook "${candidate.hook.name}" has missing or invalid metadata at ${candidate.filePath}`,
          );
        }
        if (!entry.hook.handlerPath) {
          throw new Error(
            `Hook "${candidate.hook.name}" has no readable handler in ${entry.hook.baseDir}`,
          );
        }
      }
      return entry ? [entry] : [];
    })
    .filter((entry): entry is HookEntry => Boolean(entry.hook.handlerPath));
  return {
    entries,
    sources: resolved.map(({ rootId, filePath, hook, metadata }) => ({
      rootId,
      filePath,
      hook,
      metadata,
    })),
  };
}

/** Inspect hooks best-effort without retaining an active generation's source obligations. */
export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: HookDiscoveryOptions,
): HookEntry[] {
  return prepareWorkspaceHookEntries(workspaceDir, opts).entries;
}

function readRootFileUtf8(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  maxBytes: number;
}): string | null {
  return withOpenedRootFileSync(params, (opened) => {
    try {
      return readFileDescriptorBoundedSync(opened.fd, params.maxBytes).toString("utf-8");
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn(
          `Ignoring oversized hook metadata ${params.absolutePath}: file exceeds the ${params.maxBytes}-byte limit`,
        );
      }
      return null;
    }
  });
}

function withOpenedRootFileSync<T>(
  params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
  },
  read: (opened: { fd: number; path: string }) => T,
): T | null {
  const opened = openRootFileSync({
    absolutePath: params.absolutePath,
    rootPath: params.rootPath,
    boundaryLabel: params.boundaryLabel,
    // Operator hook dirs are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the hook root.
    rejectSymlinks: false,
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

function resolveRootFilePath(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
}): string | null {
  return withOpenedRootFileSync(params, (opened) => opened.path);
}
