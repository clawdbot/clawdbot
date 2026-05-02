type LanceDbModule = typeof import("@lancedb/lancedb");

export type LanceDbRuntimeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type LanceDbRuntimeLoaderDeps = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  importBundled: () => Promise<LanceDbModule>;
};

function buildLoadFailureMessage(error: unknown): string {
  return [
    "memory-lancedb: bundled @lancedb/lancedb dependency is unavailable.",
    "Install or repair the memory-lancedb plugin package dependencies, then restart OpenClaw.",
    String(error),
  ].join(" ");
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
  load: (_logger?: LanceDbRuntimeLogger) => Promise<LanceDbModule>;
} {
  const deps: LanceDbRuntimeLoaderDeps = {
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    importBundled: overrides.importBundled ?? (() => import("@lancedb/lancedb")),
  };

  let loadPromise: Promise<LanceDbModule> | null = null;

  return {
    async load(_logger?: LanceDbRuntimeLogger): Promise<LanceDbModule> {
      if (!loadPromise) {
        loadPromise = deps.importBundled().catch((error) => {
          loadPromise = null;
          if (isUnsupportedNativePlatform({ platform: deps.platform, arch: deps.arch })) {
            throw new Error(
              buildUnsupportedNativePlatformMessage({
                platform: deps.platform,
                arch: deps.arch,
              }),
              { cause: error },
            );
          }
          throw new Error(buildLoadFailureMessage(error), { cause: error });
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
