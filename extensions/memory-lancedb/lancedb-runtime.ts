import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveStateDir } from "./api.js";

type LanceDbModule = typeof import("@lancedb/lancedb");

export type LanceDbRuntimeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type RuntimeManifest = {
  name: string;
  private: true;
  type: "module";
  dependencies: Record<string, string>;
};

type PackageJsonWithDependencies = {
  dependencies?: Record<string, string>;
};

type ReadPackageJson = (manifestPath: string) => PackageJsonWithDependencies | null;

type LanceDbRuntimeLoaderDeps = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  resolveStateDir: (env?: NodeJS.ProcessEnv, homedir?: () => string) => string;
  runtimeManifest: RuntimeManifest;
  importBundled: () => Promise<LanceDbModule>;
  importResolved: (resolvedPath: string) => Promise<LanceDbModule>;
  resolveRuntimeEntry: (params: { runtimeDir: string; manifest: RuntimeManifest }) => string | null;
  installRuntime: (params: {
    runtimeDir: string;
    manifest: RuntimeManifest;
    env: NodeJS.ProcessEnv;
    logger?: LanceDbRuntimeLogger;
  }) => Promise<string>;
};

function defaultReadPackageJson(manifestPath: string): PackageJsonWithDependencies | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageJsonWithDependencies;
  } catch {
    return null;
  }
}

function buildMemoryLanceDbManifestCandidates(modulePath: string): string[] {
  const moduleDir = path.dirname(modulePath);
  const candidates = new Set<string>();
  candidates.add(path.join(moduleDir, "package.json"));

  let cursor = moduleDir;
  while (true) {
    candidates.add(path.join(cursor, "extensions", "memory-lancedb", "package.json"));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return [...candidates];
}

export function resolveLanceDbDependencySpec(
  modulePath: string,
  readPackageJson: ReadPackageJson = defaultReadPackageJson,
): string {
  for (const manifestPath of buildMemoryLanceDbManifestCandidates(modulePath)) {
    const lanceDbSpec = readPackageJson(manifestPath)?.dependencies?.["@lancedb/lancedb"];
    if (lanceDbSpec) {
      return lanceDbSpec;
    }
  }
  throw new Error('memory-lancedb package.json is missing "@lancedb/lancedb"');
}

const MEMORY_LANCEDB_RUNTIME_MANIFEST: RuntimeManifest = (() => {
  const lanceDbSpec = resolveLanceDbDependencySpec(fileURLToPath(import.meta.url));
  return {
    name: "openclaw-memory-lancedb-runtime",
    private: true,
    type: "module",
    dependencies: {
      "@lancedb/lancedb": lanceDbSpec,
    },
  };
})();

function resolveRuntimeDir(stateDir: string): string {
  return path.join(stateDir, "plugin-runtimes", "memory-lancedb", "lancedb");
}

function readRuntimeManifest(filePath: string): RuntimeManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as RuntimeManifest;
  } catch {
    return null;
  }
}

function manifestsMatch(actual: RuntimeManifest | null, expected: RuntimeManifest): boolean {
  if (!actual) {
    return false;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function defaultResolveRuntimeEntry(params: {
  runtimeDir: string;
  manifest: RuntimeManifest;
}): string | null {
  const runtimePackagePath = path.join(params.runtimeDir, "package.json");
  if (!manifestsMatch(readRuntimeManifest(runtimePackagePath), params.manifest)) {
    return null;
  }
  try {
    const runtimeRequire = createRequire(runtimePackagePath);
    return runtimeRequire.resolve("@lancedb/lancedb");
  } catch {
    return null;
  }
}

function collectSpawnOutput(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function defaultInstallRuntime(params: {
  runtimeDir: string;
  manifest: RuntimeManifest;
  env: NodeJS.ProcessEnv;
  logger?: LanceDbRuntimeLogger;
}): Promise<string> {
  const runtimePackagePath = path.join(params.runtimeDir, "package.json");
  const currentManifest = readRuntimeManifest(runtimePackagePath);
  if (!manifestsMatch(currentManifest, params.manifest)) {
    await fs.promises.rm(path.join(params.runtimeDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    await fs.promises.rm(path.join(params.runtimeDir, "package-lock.json"), { force: true });
  }

  await fs.promises.mkdir(params.runtimeDir, { recursive: true });
  await fs.promises.writeFile(
    runtimePackagePath,
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf8",
  );

  const install = await collectSpawnOutput({
    command: "npm",
    args: ["install", "--omit=dev", "--silent", "--ignore-scripts", "--package-lock=false"],
    cwd: params.runtimeDir,
    env: params.env,
  });
  if (install.error) {
    const spawnError = install.error as NodeJS.ErrnoException;
    throw new Error(
      spawnError.code === "ENOENT"
        ? "npm is required to install the LanceDB runtime but was not found on PATH"
        : install.error.message,
    );
  }
  if ((install.code ?? 0) !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim();
    throw new Error(detail || `npm exited with code ${install.code ?? "unknown"}`);
  }

  const resolved = defaultResolveRuntimeEntry({
    runtimeDir: params.runtimeDir,
    manifest: params.manifest,
  });
  if (!resolved) {
    throw new Error("installed LanceDB runtime is missing the @lancedb/lancedb entry");
  }
  params.logger?.info?.(`memory-lancedb: installed LanceDB runtime under ${params.runtimeDir}`);
  return resolved;
}

function defaultImportResolved(resolvedPath: string): Promise<LanceDbModule> {
  return import(pathToFileURL(resolvedPath).href);
}

function buildLoadFailureMessage(prefix: string, error: unknown): string {
  return `memory-lancedb: ${prefix}. ${String(error)}`;
}

function isUnsupportedNativePlatform(params: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): boolean {
  return params.platform === "darwin" && params.arch === "x64";
}

function buildUnsupportedNativePlatformMessage(params: {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}): string {
  return [
    `memory-lancedb: LanceDB runtime is unavailable on ${params.platform}-${params.arch}.`,
    "The bundled @lancedb/lancedb dependency does not publish a native package for this platform.",
    "Disable memory-lancedb or switch to a supported memory backend/platform.",
  ].join(" ");
}

export function createLanceDbRuntimeLoader(overrides: Partial<LanceDbRuntimeLoaderDeps> = {}): {
  load: (logger?: LanceDbRuntimeLogger) => Promise<LanceDbModule>;
} {
  const deps: LanceDbRuntimeLoaderDeps = {
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    resolveStateDir: overrides.resolveStateDir ?? resolveStateDir,
    runtimeManifest: overrides.runtimeManifest ?? MEMORY_LANCEDB_RUNTIME_MANIFEST,
    importBundled: overrides.importBundled ?? (() => import("@lancedb/lancedb")),
    importResolved: overrides.importResolved ?? defaultImportResolved,
    resolveRuntimeEntry: overrides.resolveRuntimeEntry ?? defaultResolveRuntimeEntry,
    installRuntime: overrides.installRuntime ?? defaultInstallRuntime,
  };

  let loadPromise: Promise<LanceDbModule> | null = null;

  return {
    async load(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            return await deps.importBundled();
          } catch (bundledError) {
            if (isUnsupportedNativePlatform({ platform: deps.platform, arch: deps.arch })) {
              throw new Error(
                buildUnsupportedNativePlatformMessage({
                  platform: deps.platform,
                  arch: deps.arch,
                }),
                { cause: bundledError },
              );
            }
            const runtimeDir = resolveRuntimeDir(
              deps.resolveStateDir(deps.env, () =>
                deps.env.HOME?.trim() ? deps.env.HOME : os.homedir(),
              ),
            );
            const existingRuntime = deps.resolveRuntimeEntry({
              runtimeDir,
              manifest: deps.runtimeManifest,
            });
            if (existingRuntime) {
              try {
                return await deps.importResolved(existingRuntime);
              } catch {
                // Reinstall below when the cached runtime is incomplete or stale.
              }
            }
            if (deps.env.OPENCLAW_NIX_MODE === "1") {
              throw new Error(
                buildLoadFailureMessage(
                  "failed to load LanceDB and Nix mode disables auto-install",
                  bundledError,
                ),
                { cause: bundledError },
              );
            }
            logger?.warn?.(
              `memory-lancedb: bundled LanceDB runtime unavailable (${String(bundledError)}); installing runtime deps under ${runtimeDir}`,
            );
            const installedEntry = await deps.installRuntime({
              runtimeDir,
              manifest: deps.runtimeManifest,
              env: deps.env,
              logger,
            });
            try {
              return await deps.importResolved(installedEntry);
            } catch (runtimeError) {
              throw new Error(
                buildLoadFailureMessage(
                  "failed to load LanceDB after installing runtime deps",
                  runtimeError,
                ),
                { cause: runtimeError },
              );
            }
          }
        })().catch((error) => {
          loadPromise = null;
          throw error;
        });
      }
      return await loadPromise;
    },
  };
}

const defaultLoader = createLanceDbRuntimeLoader();

export async function loadLanceDbModule(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
  return await defaultLoader.load(logger);
}
