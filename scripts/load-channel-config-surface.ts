import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { buildChannelConfigSchema } from "../src/channels/plugins/config-schema.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
} from "../src/plugins/sdk-alias.js";

function isBuiltChannelConfigSchema(
  value: unknown,
): value is { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function resolveConfigSchemaExport(
  imported: Record<string, unknown>,
): { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolvePackageRoot(modulePath: string): string {
  let cursor = path.dirname(path.resolve(modulePath));
  while (true) {
    if (fs.existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`package root not found for ${modulePath}`);
    }
    cursor = parent;
  }
}

function shouldRetryViaIsolatedCopy(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return code === "ERR_MODULE_NOT_FOUND" && message.includes(`${path.sep}node_modules${path.sep}`);
}

function isMissingExecutableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && error.code === "ENOENT";
}

const SOURCE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveImportCandidates(basePath: string): string[] {
  const extension = path.extname(basePath);
  const candidates = new Set<string>([basePath]);
  if (extension) {
    const stem = basePath.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
      candidates.add(`${stem}${sourceExtension}`);
    }
  } else {
    for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
      candidates.add(`${basePath}${sourceExtension}`);
      candidates.add(path.join(basePath, `index${sourceExtension}`));
    }
  }
  return Array.from(candidates);
}

function resolveRelativeImportPath(fromFile: string, specifier: string): string | null {
  for (const candidate of resolveImportCandidates(
    path.resolve(path.dirname(fromFile), specifier),
  )) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectRelativeImportGraph(entryPath: string): Set<string> {
  const discovered = new Set<string>();
  const queue = [path.resolve(entryPath)];
  const importPattern =
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath || discovered.has(currentPath)) {
      continue;
    }
    discovered.add(currentPath);

    const source = fs.readFileSync(currentPath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeImportPath(currentPath, specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }

  return discovered;
}

function resolveCommonAncestor(paths: Iterable<string>): string {
  const resolvedPaths = Array.from(paths, (entry) => path.resolve(entry));
  const [first, ...rest] = resolvedPaths;
  if (!first) {
    throw new Error("cannot resolve common ancestor for empty path set");
  }
  let ancestor = first;
  for (const candidate of rest) {
    while (path.relative(ancestor, candidate).startsWith(`..${path.sep}`)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return ancestor;
      }
      ancestor = parent;
    }
  }
  return ancestor;
}

function copyModuleImportGraphWithoutNodeModules(params: {
  modulePath: string;
  repoRoot: string;
}): {
  copiedModulePath: string;
  cleanup: () => void;
} {
  const packageRoot = resolvePackageRoot(params.modulePath);
  const relativeFiles = collectRelativeImportGraph(params.modulePath);
  const copyRoot = resolveCommonAncestor([packageRoot, ...relativeFiles]);
  const relativeModulePath = path.relative(copyRoot, params.modulePath);
  const tempParent = path.join(params.repoRoot, ".openclaw-config-doc-cache");
  fs.mkdirSync(tempParent, { recursive: true });
  const isolatedRoot = fs.mkdtempSync(path.join(tempParent, `${path.basename(packageRoot)}-`));

  for (const sourcePath of relativeFiles) {
    const relativePath = path.relative(copyRoot, sourcePath);
    const targetPath = path.join(isolatedRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return {
    copiedModulePath: path.join(isolatedRoot, relativeModulePath),
    cleanup: () => {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    },
  };
}

export async function loadChannelConfigSurfaceModule(
  modulePath: string,
  options?: { repoRoot?: string },
): Promise<{ schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const loaderRepoRoot = resolveRepoRoot();
  const bunBuildChannelConfigSchemaUrl = pathToFileURL(
    path.join(loaderRepoRoot, "src/channels/plugins/config-schema.ts"),
  ).href;
  const loadViaBun = (candidatePath: string) => {
    const script = `
      import { pathToFileURL } from "node:url";
      const { buildChannelConfigSchema } = await import(${JSON.stringify(bunBuildChannelConfigSchemaUrl)});
      const modulePath = process.env.OPENCLAW_CONFIG_SURFACE_MODULE;
      if (!modulePath) {
        throw new Error("missing OPENCLAW_CONFIG_SURFACE_MODULE");
      }
      const imported = await import(pathToFileURL(modulePath).href);
      const isBuilt = (value) => Boolean(
        value &&
          typeof value === "object" &&
          value.schema &&
          typeof value.schema === "object"
      );
      const resolve = (mod) => {
        for (const [name, value] of Object.entries(mod)) {
          if (name.endsWith("ChannelConfigSchema") && isBuilt(value)) return value;
        }
        for (const [name, value] of Object.entries(mod)) {
          if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) continue;
          if (isBuilt(value)) return value;
          if (value && typeof value === "object") return buildChannelConfigSchema(value);
        }
        for (const value of Object.values(mod)) {
          if (isBuilt(value)) return value;
        }
        return null;
      };
      process.stdout.write(JSON.stringify(resolve(imported)));
    `;
    const result = spawnSync("bun", ["-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_SURFACE_MODULE: path.resolve(candidatePath),
      },
    });
    if (result.error) {
      if (isMissingExecutableError(result.error)) {
        return null;
      }
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `bun loader failed for ${candidatePath}`);
    }
    return JSON.parse(result.stdout || "null") as {
      schema: Record<string, unknown>;
      uiHints?: Record<string, unknown>;
    } | null;
  };
  const loadViaJiti = (candidatePath: string) => {
    const resolvedPath = path.resolve(candidatePath);
    const pluginSdkAlias = resolvePluginSdkAliasFile({
      srcFile: "root-alias.cjs",
      distFile: "root-alias.cjs",
      modulePath: resolvedPath,
      pluginSdkResolution: "src",
    });
    const aliasMap = {
      ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
      ...resolvePluginSdkScopedAliasMap({
        modulePath: resolvedPath,
        pluginSdkResolution: "src",
      }),
    };
    const jiti = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      interopDefault: true,
      tryNative: false,
      moduleCache: false,
      fsCache: false,
    });
    return jiti(resolvedPath) as Record<string, unknown>;
  };
  const loadFromPath = (
    candidatePath: string,
  ): { schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null => {
    try {
      // Prefer the source-aware Jiti path so generated config metadata stays
      // stable before and after build output exists in the repo.
      const imported = loadViaJiti(candidatePath);
      const resolved = resolveConfigSchemaExport(imported);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall back to Bun below when the source-aware loader cannot resolve the
      // module graph in the current environment.
    }

    const bunLoaded = loadViaBun(candidatePath);
    if (bunLoaded && isBuiltChannelConfigSchema(bunLoaded)) {
      return bunLoaded;
    }
    return null;
  };

  try {
    return loadFromPath(modulePath);
  } catch (error) {
    if (!shouldRetryViaIsolatedCopy(error)) {
      throw error;
    }

    const isolatedCopy = copyModuleImportGraphWithoutNodeModules({ modulePath, repoRoot });
    try {
      return loadFromPath(isolatedCopy.copiedModulePath);
    } finally {
      isolatedCopy.cleanup();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const modulePath = process.argv[2]?.trim();
  if (!modulePath) {
    process.exit(2);
  }

  const resolved = await loadChannelConfigSurfaceModule(modulePath);
  if (!resolved) {
    process.exit(3);
  }

  process.stdout.write(JSON.stringify(resolved));
  process.exit(0);
}
